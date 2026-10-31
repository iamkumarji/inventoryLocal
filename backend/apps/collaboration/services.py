"""Tasks, comments with mentions, record activity timelines and task escalation."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.audit.models import AuditEvent
from apps.authorization import pdp
from apps.authorization.models import RoleAssignment
from apps.authorization.snapshot import get_snapshot
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition, VersionConflict
from apps.core.outbox import publish_event
from apps.notifications.models import Category, Notification
from apps.notifications.services import notify

from . import mentions, records
from .models import Comment, CommentRevision, EscalationRule, Mention, Task, TaskEscalation

logger = logging.getLogger("erp.collaboration")

TASK = "collaboration.task"
COMMENT = "collaboration.comment"
EDIT_WINDOW = timedelta(minutes=15)
MAX_COMMENT_LENGTH = 10_000
TASK_EDITABLE = ("title", "description", "priority", "due_at", "department")

TRANSITIONS = {
    Task.Status.OPEN: {Task.Status.IN_PROGRESS, Task.Status.DONE, Task.Status.CANCELLED},
    Task.Status.IN_PROGRESS: {Task.Status.OPEN, Task.Status.DONE, Task.Status.CANCELLED},
    Task.Status.DONE: {Task.Status.OPEN},
    Task.Status.CANCELLED: {Task.Status.OPEN},
}


def _check_version(instance, expected_version: int | None) -> None:
    if expected_version is None or instance.version != expected_version:
        raise VersionConflict()


def task_link(task: Task) -> str:
    return f"/collaboration/tasks/{task.pk}"


def record_link(resource_type: str, resource_id: str) -> str:
    return f"/records/{resource_type}/{resource_id}"


# --- Tasks -----------------------------------------------------------------------------------------


def _task_resource(company_id, department_id=None) -> pdp.Resource:
    attrs: dict[str, Any] = {"company_id": company_id}
    if department_id is not None:
        attrs["department_id"] = department_id
    return pdp.Resource.ref(TASK, **attrs)


def _validate_assignee(assignee, company_id, organization_id) -> None:
    if not assignee.is_active or assignee.organization_id != organization_id:
        raise ValidationError({"assignee": ["Unknown or inactive user."]})
    if company_id not in get_snapshot(assignee.pk).companies:
        raise ValidationError({"assignee": ["The user has no access to this company."]})


def _notify_assignee(ctx: ActorContext, task: Task) -> None:
    if task.assignee_id is None or task.assignee_id == ctx.user_id:
        return
    notify(
        [task.assignee],
        category=Category.TASK,
        title=f"Task assigned to you: {task.title}",
        body=f"Due {timezone.localtime(task.due_at):%d %b %Y %H:%M}" if task.due_at else "",
        link=task_link(task),
        resource_type=TASK,
        resource_id=task.pk,
        dedupe_key=f"task-assigned:{task.pk}:{task.assignee_id}:{task.version}",
        company_id=task.company_id,
    )


def _task_event(event: str, ctx: ActorContext, task: Task, changes: dict | None = None, summary: str = "") -> None:
    audit.record(
        f"{TASK}.{event}",
        ctx=ctx,
        resource_type=TASK,
        resource_id=task.pk,
        company_id=task.company_id,
        summary=summary or task.title,
        changes=changes,
    )
    publish_event(
        f"{TASK}.{event}",
        aggregate_type=TASK,
        aggregate_id=task.pk,
        company_id=task.company_id,
        payload={"status": task.status, "assignee_id": task.assignee_id},
    )


@transaction.atomic
def create_task(
    ctx: ActorContext,
    *,
    title: str,
    description: str = "",
    priority: str = Task.Priority.NORMAL,
    due_at: datetime | None = None,
    assignee=None,
    company=None,
    department=None,
    resource_type: str = "",
    resource_id: str = "",
) -> Task:
    record_company = None
    if resource_type or resource_id:
        if not (resource_type and resource_id):
            raise ValidationError({"resource_id": ["Give both resource_type and resource_id."]})
        record_company = records.record_company_id(records.resolve(ctx, resource_type, resource_id))
    company_id = company.pk if company is not None else (record_company or ctx.company_id)
    if company_id is None:
        raise ValidationError({"company": ["Select a company."]})
    if record_company is not None and record_company != company_id:
        raise ValidationError({"company": ["The task must belong to the linked record's company."]})
    if department is not None and department.company_id != company_id:
        raise ValidationError({"department": ["The department belongs to another company."]})
    resource = _task_resource(company_id, department.pk if department else None)
    pdp.require(ctx, f"{TASK}.create", resource)
    if assignee is not None:
        pdp.require(ctx, f"{TASK}.assign", resource)
        _validate_assignee(assignee, company_id, ctx.user.organization_id)
    task = Task.objects.create(
        company_id=company_id,
        title=title,
        description=description,
        priority=priority,
        due_at=due_at,
        assignee=assignee,
        department=department,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id else "",
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    _task_event(
        "created",
        ctx,
        task,
        changes={"after": audit.snapshot(task, ("title", "priority", "due_at", "assignee", "status"))},
    )
    _notify_assignee(ctx, task)
    return task


@transaction.atomic
def update_task(ctx: ActorContext, task: Task, data: dict, expected_version: int | None) -> Task:
    task = Task.objects.select_for_update().get(pk=task.pk)
    pdp.require(ctx, f"{TASK}.update", pdp.Resource.of(task))
    _check_version(task, expected_version)
    unknown = set(data) - set(TASK_EDITABLE)
    if unknown:
        raise ValidationError({field: ["This field cannot be changed."] for field in sorted(unknown)})
    if not task.is_active:
        raise InvalidStateTransition("Reopen the task before editing it.")
    if "department" in data and data["department"] is not None and data["department"].company_id != task.company_id:
        raise ValidationError({"department": ["The department belongs to another company."]})
    before = audit.snapshot(task, TASK_EDITABLE)
    for key, value in data.items():
        setattr(task, key, value)
    if "department" in data:
        # Moving the task must stay within the actor's update scope.
        pdp.require(ctx, f"{TASK}.update", pdp.Resource.of(task))
    if "due_at" in data and before["due_at"] != audit.snapshot(task, ("due_at",))["due_at"]:
        task.escalations.all().delete()  # a new deadline can escalate again
        task.escalated_at = None
    task.version += 1
    task.updated_by = ctx.user
    task.save()
    changes = audit.diff(before, audit.snapshot(task, TASK_EDITABLE))
    if changes:
        _task_event("updated", ctx, task, changes=changes)
    return task


@transaction.atomic
def assign_task(ctx: ActorContext, task: Task, assignee, expected_version: int | None) -> Task:
    task = Task.objects.select_for_update().get(pk=task.pk)
    pdp.require(ctx, f"{TASK}.assign", pdp.Resource.of(task))
    _check_version(task, expected_version)
    if not task.is_active:
        raise InvalidStateTransition("Only open tasks can be assigned.")
    if assignee is not None:
        _validate_assignee(assignee, task.company_id, ctx.user.organization_id)
    previous = task.assignee_id
    if previous == (assignee.pk if assignee else None):
        return task
    task.assignee = assignee
    task.version += 1
    task.updated_by = ctx.user
    task.save(update_fields=["assignee", "version", "updated_by", "updated_at"])
    _task_event(
        "assigned",
        ctx,
        task,
        changes={"assignee": {"from": str(previous) if previous else None, "to": str(task.assignee_id or "") or None}},
    )
    _notify_assignee(ctx, task)
    return task


@transaction.atomic
def transition_task(ctx: ActorContext, task: Task, status: str, expected_version: int | None) -> Task:
    task = Task.objects.select_for_update().get(pk=task.pk)
    pdp.require(ctx, f"{TASK}.update", pdp.Resource.of(task))
    _check_version(task, expected_version)
    if status not in TRANSITIONS.get(task.status, set()):
        raise InvalidStateTransition(f"A {task.status} task can't move to {status}.")
    previous = task.status
    task.status = status
    task.completed_at = timezone.now() if status == Task.Status.DONE else None
    task.version += 1
    task.updated_by = ctx.user
    task.save(update_fields=["status", "completed_at", "version", "updated_by", "updated_at"])
    _task_event("status_changed", ctx, task, changes={"status": {"from": previous, "to": status}})
    if status == Task.Status.DONE and task.created_by_id and task.created_by_id != ctx.user_id:
        notify(
            [task.created_by],
            category=Category.TASK,
            title=f"Task completed: {task.title}",
            link=task_link(task),
            resource_type=TASK,
            resource_id=task.pk,
            dedupe_key=f"task-done:{task.pk}:{task.version}",
            company_id=task.company_id,
        )
    return task


def my_tasks(ctx: ActorContext):
    """The caller's assigned tasks in the active company context."""
    if ctx.user is None or ctx.company_id is None:
        return Task.objects.none()
    return Task.objects.filter(assignee_id=ctx.user_id, company_id=ctx.company_id)


# --- Comments and mentions -------------------------------------------------------------------------


def _clean_body(body: str) -> str:
    body = (body or "").strip()
    if not body:
        raise ValidationError({"body": ["Write something."]})
    if len(body) > MAX_COMMENT_LENGTH:
        raise ValidationError({"body": [f"At most {MAX_COMMENT_LENGTH} characters."]})
    return body


def _comment_resource(company_id) -> pdp.Resource:
    return pdp.Resource.ref(COMMENT, scope_fields={}, company_id=company_id)


def _notify_mentions(ctx: ActorContext, comment: Comment, record) -> list:
    """Notify mentioned users who can read the record; others are silently skipped (no leak)."""
    already = set(comment.mentions.values_list("user_id", flat=True))
    notified = []
    for user in mentions.resolve_users(comment.body, ctx.user.organization_id):
        if user.pk == ctx.user_id or user.pk in already:
            continue
        if not records.user_can_read(user, comment.resource_type, record):
            continue
        Mention.objects.create(comment=comment, user=user)
        notified.append(user)
    if notified:
        notify(
            notified,
            category=Category.TASK,
            title=f"{ctx.user.full_name} mentioned you in a comment",
            body=comment.body[:300],
            link=f"{record_link(comment.resource_type, comment.resource_id)}?comment={comment.pk}",
            resource_type=comment.resource_type,
            resource_id=comment.resource_id,
            dedupe_key=f"mention:{comment.pk}",
            company_id=comment.company_id,
        )
    return notified


def _comment_audit(event: str, ctx: ActorContext, comment: Comment, changes: dict | None = None) -> None:
    audit.record(
        f"{COMMENT}.{event}",
        ctx=ctx,
        resource_type=COMMENT,
        resource_id=comment.pk,
        company_id=comment.company_id,
        summary=f"{comment.resource_type}:{comment.resource_id}",
        changes=changes,
    )


@transaction.atomic
def add_comment(ctx: ActorContext, *, resource_type: str, resource_id: str, body: str) -> Comment:
    record = records.resolve(ctx, resource_type, resource_id)
    company_id = records.record_company_id(record)
    pdp.require(ctx, f"{COMMENT}.create", _comment_resource(company_id))
    comment = Comment.objects.create(
        company_id=company_id,
        resource_type=resource_type,
        resource_id=str(record.pk),
        author=ctx.user,
        body=_clean_body(body),
    )
    _notify_mentions(ctx, comment, record)
    _comment_audit("created", ctx, comment)
    publish_event(
        f"{COMMENT}.created",
        aggregate_type=COMMENT,
        aggregate_id=comment.pk,
        company_id=company_id,
        payload={"resource_type": resource_type, "resource_id": comment.resource_id},
    )
    return comment


def _locked_own_comment(ctx: ActorContext, comment: Comment, expected_version: int | None):
    comment = Comment.objects.select_for_update().get(pk=comment.pk)
    record = records.resolve(ctx, comment.resource_type, comment.resource_id)
    pdp.require(ctx, f"{COMMENT}.update", pdp.Resource.of(comment))
    if comment.author_id != ctx.user_id:
        raise AuthorizationDenied("not_comment_author")
    if comment.is_removed:
        raise InvalidStateTransition("The comment was removed.")
    _check_version(comment, expected_version)
    return comment, record


@transaction.atomic
def edit_comment(ctx: ActorContext, comment: Comment, body: str, expected_version: int | None) -> Comment:
    comment, record = _locked_own_comment(ctx, comment, expected_version)
    if timezone.now() - comment.created_at > EDIT_WINDOW:
        raise BusinessRuleViolation("Comments can only be edited within 15 minutes.", code="edit_window_closed")
    body = _clean_body(body)
    if body == comment.body:
        return comment
    revision_no = comment.revisions.count() + 1
    CommentRevision.objects.create(
        comment=comment, revision_no=revision_no, body=comment.body, edited_by=ctx.user, edited_at=timezone.now()
    )
    comment.body = body
    comment.edited_at = timezone.now()
    comment.version += 1
    comment.save(update_fields=["body", "edited_at", "version", "updated_at"])
    _notify_mentions(ctx, comment, record)
    _comment_audit("edited", ctx, comment, changes={"revision": revision_no})
    return comment


@transaction.atomic
def remove_comment(ctx: ActorContext, comment: Comment, expected_version: int | None) -> Comment:
    comment, _ = _locked_own_comment(ctx, comment, expected_version)
    comment.is_removed = True
    comment.removed_at = timezone.now()
    comment.removed_by = ctx.user
    comment.version += 1
    comment.save(update_fields=["is_removed", "removed_at", "removed_by", "version", "updated_at"])
    _comment_audit("removed", ctx, comment)
    return comment


def comments_for(ctx: ActorContext, resource_type: str, resource_id: str):
    record = records.resolve(ctx, resource_type, resource_id)
    return Comment.objects.filter(resource_type=resource_type, resource_id=str(record.pk)).select_related("author")


def require_comment_access(ctx: ActorContext, comment: Comment) -> None:
    records.resolve(ctx, comment.resource_type, comment.resource_id)


# --- Activity timeline -------------------------------------------------------------------------------


def activity(ctx: ActorContext, resource_type: str, resource_id: str, limit: int = 200) -> list[dict]:
    """Comments and audit events of a record, newest first. Audit change payloads are not exposed."""
    record = records.resolve(ctx, resource_type, resource_id)
    rid = str(record.pk)
    entries = [
        {
            "kind": "comment",
            "id": c.pk,
            "occurred_at": c.created_at,
            "actor_id": c.author_id,
            "actor_label": c.author.full_name,
            "action": f"{COMMENT}.removed" if c.is_removed else f"{COMMENT}.created",
            "summary": "" if c.is_removed else c.body,
            "edited_at": c.edited_at,
        }
        for c in Comment.objects.filter(resource_type=resource_type, resource_id=rid)
        .select_related("author")
        .order_by("-created_at")[:limit]
    ]
    events = list(
        AuditEvent.objects.filter(
            resource_type=resource_type, resource_id=rid, outcome=AuditEvent.Outcome.SUCCESS
        ).order_by("-occurred_at")[:limit]
    )
    # Audit events store the actor's email at the time; show people by name, as comments do.
    names = dict(
        get_user_model()
        .objects.filter(pk__in={e.actor_id for e in events if e.actor_id})
        .values_list("pk", "full_name")
    )
    entries += [
        {
            "kind": "audit",
            "id": e.pk,
            "occurred_at": e.occurred_at,
            "actor_id": e.actor_id,
            "actor_label": names.get(e.actor_id) or e.actor_label,
            "action": e.action,
            "summary": e.summary,
            "edited_at": None,
        }
        for e in events
    ]
    entries.sort(key=lambda item: item["occurred_at"], reverse=True)
    return entries[:limit]


# --- Escalation --------------------------------------------------------------------------------------


def _can_read_task(user, task: Task) -> bool:
    if user is None or not user.is_active:
        return False
    if user.pk in (task.assignee_id, task.created_by_id):
        return True
    return pdp.can(records.entitlement_ctx(user, task.company_id), f"{TASK}.read", pdp.Resource.of(task))


def _role_holders(rule: EscalationRule, task: Task, now: datetime) -> list:
    assignments = (
        RoleAssignment.objects.filter(role_id=rule.role_id, role__is_active=True, revoked_at__isnull=True)
        .filter(Q(valid_from__isnull=True) | Q(valid_from__lte=now))
        .filter(Q(valid_until__isnull=True) | Q(valid_until__gt=now))
        .filter(Q(company_id=task.company_id) | Q(scope_type="organization", organization_id=rule.role.organization_id))
        .select_related("user")
    )
    return [a.user for a in assignments]


def escalation_recipients(rule: EscalationRule, task: Task, now: datetime) -> list:
    if rule.target == EscalationRule.Target.ROLE:
        candidates = _role_holders(rule, task, now)
    elif rule.target == EscalationRule.Target.DEPARTMENT_HEAD:
        candidates = [task.department.head_user] if task.department_id and task.department.head_user_id else []
    else:
        candidates = [task.assignee] if task.assignee_id else []
    unique = {u.pk: u for u in candidates if u is not None}
    return [u for u in unique.values() if _can_read_task(u, task)]


def escalate_overdue_tasks(now: datetime | None = None) -> int:
    """Escalate active tasks overdue by each active rule's threshold. Idempotent per (task, rule)."""
    now = now or timezone.now()
    system = ActorContext.system("task_escalation")
    count = 0
    for rule in EscalationRule.objects.filter(is_active=True).select_related("role").order_by("overdue_hours"):
        with transaction.atomic():
            tasks = (
                Task.objects.select_for_update(skip_locked=True, of=("self",))
                .filter(
                    company_id=rule.company_id,
                    status__in=[Task.Status.OPEN, Task.Status.IN_PROGRESS],
                    due_at__isnull=False,
                    due_at__lte=now - timedelta(hours=rule.overdue_hours),
                )
                .exclude(escalations__rule=rule)
                .select_related("assignee", "created_by", "department__head_user")
            )
            if rule.priority:
                tasks = tasks.filter(priority=rule.priority)
            for task in tasks:
                try:
                    with transaction.atomic():
                        escalation = TaskEscalation.objects.create(task=task, rule=rule, escalated_at=now)
                except IntegrityError:
                    continue  # escalated concurrently
                recipients = escalation_recipients(rule, task, now)
                escalation.recipients = len(recipients)
                escalation.save(update_fields=["recipients"])
                task.escalated_at = now
                task.escalation_count += 1
                task.save(update_fields=["escalated_at", "escalation_count"])
                notify(
                    recipients,
                    category=Category.TASK,
                    severity=Notification.Severity.WARNING,
                    title=f"Overdue task: {task.title}",
                    body=f"Overdue by more than {rule.overdue_hours} h ({rule.name}).",
                    link=task_link(task),
                    resource_type=TASK,
                    resource_id=task.pk,
                    dedupe_key=f"task-escalation:{task.pk}:{rule.pk}",
                    company_id=task.company_id,
                )
                audit.record(
                    f"{TASK}.escalated",
                    ctx=system,
                    resource_type=TASK,
                    resource_id=task.pk,
                    company_id=task.company_id,
                    summary=f"{rule.code}: {task.title}",
                    changes={"rule": rule.code, "recipients": len(recipients)},
                )
                publish_event(
                    f"{TASK}.escalated",
                    aggregate_type=TASK,
                    aggregate_id=task.pk,
                    company_id=task.company_id,
                    payload={"rule": rule.code, "recipients": len(recipients)},
                )
                count += 1
    return count
