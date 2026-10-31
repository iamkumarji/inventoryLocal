from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import AuthzResourceMixin, CompanyScopedModel, TimeStampedModel, UUIDModel, VersionedModel


class Task(CompanyScopedModel, VersionedModel):
    """A unit of work, optionally linked to any business record via (resource_type, resource_id)."""

    class Status(models.TextChoices):
        OPEN = "open"
        IN_PROGRESS = "in_progress"
        DONE = "done"
        CANCELLED = "cancelled"

    class Priority(models.TextChoices):
        LOW = "low"
        NORMAL = "normal"
        HIGH = "high"
        URGENT = "urgent"

    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.NORMAL)
    due_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=15, choices=Status.choices, default=Status.OPEN)
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    # Users carry no department yet (HR, Phase 6); the task's department drives department-scoped grants
    # and "department head" escalation.
    department = models.ForeignKey(
        "organization.Department", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    resource_type = models.CharField(max_length=100, blank=True)
    resource_id = models.CharField(max_length=64, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    escalated_at = models.DateTimeField(null=True, blank=True)
    escalation_count = models.PositiveIntegerField(default=0)

    authz_resource_type = "collaboration.task"
    authz_scope_fields = {"company": "company_id", "department": "department_id"}

    class Meta:
        db_table = "collab_tasks"
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=["open", "in_progress", "done", "cancelled"]), name="ck_task_status"
            ),
            models.CheckConstraint(
                condition=Q(priority__in=["low", "normal", "high", "urgent"]), name="ck_task_priority"
            ),
            models.CheckConstraint(
                condition=(Q(resource_type="") & Q(resource_id="")) | (~Q(resource_type="") & ~Q(resource_id="")),
                name="ck_task_record_ref",
            ),
        ]
        indexes = [
            models.Index(fields=["assignee", "status"], name="ix_task_assignee_status"),
            models.Index(fields=["resource_type", "resource_id"], name="ix_task_record"),
            models.Index(fields=["due_at"], name="ix_task_open_due", condition=Q(status__in=["open", "in_progress"])),
        ]

    def __str__(self) -> str:
        return self.title

    @property
    def is_active(self) -> bool:
        return self.status in (self.Status.OPEN, self.Status.IN_PROGRESS)

    def authz_attributes(self) -> dict:
        attrs = super().authz_attributes()
        attrs["owner_id"] = self.assignee_id  # used by the `allow_own_tasks` policy template
        return attrs


class Comment(AuthzResourceMixin, TimeStampedModel):
    """A comment on any business record. Never hard-deleted (DB trigger); removal is a soft flag."""

    company = models.ForeignKey(
        "organization.Company", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    resource_type = models.CharField(max_length=100)
    resource_id = models.CharField(max_length=64)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    body = models.TextField()
    edited_at = models.DateTimeField(null=True, blank=True)
    is_removed = models.BooleanField(default=False)
    removed_at = models.DateTimeField(null=True, blank=True)
    removed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    version = models.PositiveIntegerField(default=1)

    authz_resource_type = "collaboration.comment"
    # No scope fields: the module permission is checked at any scope, the real access decision is
    # delegated to the target record.
    authz_scope_fields: dict[str, str] = {}

    class Meta:
        db_table = "collab_comments"
        indexes = [models.Index(fields=["resource_type", "resource_id", "created_at"], name="ix_comment_record")]

    def authz_attributes(self) -> dict:
        attrs = super().authz_attributes()
        attrs["owner_id"] = self.author_id
        return attrs


class CommentRevision(UUIDModel):
    """Previous body of an edited comment (append-only)."""

    comment = models.ForeignKey(Comment, on_delete=models.PROTECT, related_name="revisions")
    revision_no = models.PositiveIntegerField()
    body = models.TextField()
    edited_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    edited_at = models.DateTimeField()

    class Meta:
        db_table = "collab_comment_revisions"
        constraints = [models.UniqueConstraint(fields=["comment", "revision_no"], name="uq_comment_revision")]


class Mention(UUIDModel):
    """A user mentioned in a comment who can read the record (only those are stored and notified)."""

    comment = models.ForeignKey(Comment, on_delete=models.PROTECT, related_name="mentions")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "collab_mentions"
        constraints = [models.UniqueConstraint(fields=["comment", "user"], name="uq_mention_comment_user")]


class EscalationRule(CompanyScopedModel, VersionedModel):
    """Configuration (data, not code): escalate active tasks overdue by `overdue_hours`."""

    class Target(models.TextChoices):
        ROLE = "role"  # every holder of `role` in the task's company (or organization-wide)
        DEPARTMENT_HEAD = "department_head"  # head of the task's department
        ASSIGNEE = "assignee"  # reminder to the assignee

    code = models.CharField(max_length=40)
    name = models.CharField(max_length=150)
    overdue_hours = models.PositiveIntegerField()
    target = models.CharField(max_length=20, choices=Target.choices)
    role = models.ForeignKey("authorization.Role", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    priority = models.CharField(
        max_length=10, choices=Task.Priority.choices, blank=True, help_text="Only tasks of this priority (blank: all)."
    )
    is_active = models.BooleanField(default=True)

    authz_resource_type = "collaboration.escalation_rule"

    class Meta:
        db_table = "collab_escalation_rules"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_escalation_rule_code"),
            models.CheckConstraint(
                condition=Q(target__in=["role", "department_head", "assignee"]), name="ck_escalation_target"
            ),
            models.CheckConstraint(condition=~Q(target="role") | Q(role__isnull=False), name="ck_escalation_role"),
        ]

    def __str__(self) -> str:
        return self.code

    def clean(self):
        from django.core.exceptions import ValidationError

        if self.target == self.Target.ROLE and self.role_id is None:
            raise ValidationError({"role": ["A role is required for role escalation."]})
        if self.target != self.Target.ROLE and self.role_id is not None:
            raise ValidationError({"role": ["Only role escalation takes a role."]})


class TaskEscalation(UUIDModel):
    """One row per (task, rule) makes escalation idempotent."""

    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="escalations")
    rule = models.ForeignKey(EscalationRule, on_delete=models.PROTECT, related_name="+")
    escalated_at = models.DateTimeField()
    recipients = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "collab_task_escalations"
        constraints = [models.UniqueConstraint(fields=["task", "rule"], name="uq_task_escalation_rule")]
