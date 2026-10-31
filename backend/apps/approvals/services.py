"""Generic approval engine (docs/RBAC_ABAC.md §6).

Rules:
* A request needs every matrix level whose min_amount <= amount and whose condition holds.
* A step can be decided only by a user who holds the step's role in a scope covering the
  document, and who passes the PDP for `<document_type>.approve` / `.reject`.
  The approval limit is applied at the final step (intermediate steps endorse).
* Nobody approves their own request (PDP guard) and nobody decides two steps of one request.
* Delegates act with the delegator's authority, never on their own requests.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from decimal import Decimal
from uuid import UUID

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.authorization.conditions import Attributes, ConditionError, evaluate
from apps.authorization.conditions import validate as validate_condition
from apps.authorization.models import Role, RoleAssignment
from apps.authorization.snapshot import get_snapshot
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition, VersionConflict
from apps.core.outbox import publish_event
from apps.identity.models import User

from . import registry
from .models import ApprovalDelegation, ApprovalLevel, ApprovalMatrix, ApprovalRequest, ApprovalStep

SCOPE_ATTRS = ("company_id", "branch_id", "facility_id", "warehouse_id", "department_id")


# --- Matrices -------------------------------------------------------------------------------


def _validate_levels(organization, levels: list[dict]) -> None:
    if not levels:
        raise ValidationError({"levels": ["At least one level is required."]})
    sequences = [lvl["sequence"] for lvl in levels]
    if len(set(sequences)) != len(sequences):
        raise ValidationError({"levels": ["Level sequences must be unique."]})
    for index, level in enumerate(levels):
        problems = validate_condition(level.get("condition") or {})
        if problems:
            raise ValidationError({f"levels[{index}].condition": problems})
        for key in ("role", "escalation_role"):
            role = level.get(key)
            if role is not None and role.organization_id != organization.pk:
                raise ValidationError({f"levels[{index}].{key}": ["Role belongs to another organization."]})
        if level.get("escalation_role") is not None and not level.get("escalation_hours"):
            raise ValidationError({f"levels[{index}].escalation_hours": ["Required when an escalation role is set."]})


@transaction.atomic
def save_matrix(
    ctx: ActorContext,
    *,
    organization,
    data: dict,
    matrix: ApprovalMatrix | None = None,
    expected_version: int | None = None,
) -> ApprovalMatrix:
    levels = data.pop("levels", None)
    if matrix is None:
        company = data.get("company")
        pdp.require(
            ctx,
            "approvals.approval_matrix.manage",
            pdp.Resource.ref(
                "approvals.approval_matrix", organization_id=organization.pk, company_id=company.pk if company else None
            ),
        )
        _validate_levels(organization, levels or [])
        matrix = ApprovalMatrix(organization=organization, created_by=ctx.user, **data)
        before: dict = {}
    else:
        matrix = ApprovalMatrix.objects.select_for_update().get(pk=matrix.pk)
        pdp.require(ctx, "approvals.approval_matrix.manage", pdp.Resource.of(matrix))
        if expected_version is None or matrix.version != expected_version:
            raise VersionConflict()
        before = {"name": matrix.name, "is_active": matrix.is_active, "levels": _levels_snapshot(matrix)}
        for field in ("name", "description", "is_active"):
            if field in data:
                setattr(matrix, field, data[field])
        matrix.version += 1
        if levels is not None:
            _validate_levels(organization, levels)
    matrix.updated_by = ctx.user
    matrix.save()
    if levels is not None:
        # In-flight requests keep their own step snapshots, so replacing levels is safe.
        matrix.levels.all().delete()
        ApprovalLevel.objects.bulk_create(
            [
                ApprovalLevel(
                    matrix=matrix,
                    sequence=lvl["sequence"],
                    name=lvl["name"],
                    role=lvl["role"],
                    min_amount=lvl.get("min_amount") or Decimal("0"),
                    condition=lvl.get("condition") or {},
                    escalation_hours=lvl.get("escalation_hours"),
                    escalation_role=lvl.get("escalation_role"),
                )
                for lvl in levels
            ]
        )
    after = {"name": matrix.name, "is_active": matrix.is_active, "levels": _levels_snapshot(matrix)}
    audit.record(
        "approvals.approval_matrix.saved",
        ctx=ctx,
        resource_type="approvals.approval_matrix",
        resource_id=matrix.pk,
        company_id=matrix.company_id,
        changes=audit.diff(before, after),
    )
    return matrix


def _levels_snapshot(matrix: ApprovalMatrix) -> list[dict]:
    return [
        {
            "sequence": lvl.sequence,
            "name": lvl.name,
            "role": lvl.role.code,
            "min_amount": str(lvl.min_amount),
            "condition": lvl.condition,
            "escalation_hours": lvl.escalation_hours,
        }
        for lvl in matrix.levels.select_related("role").order_by("sequence")
    ]


def resolve_matrix(organization_id, company_id, document_type: str) -> ApprovalMatrix | None:
    qs = ApprovalMatrix.objects.filter(organization_id=organization_id, document_type=document_type, is_active=True)
    return qs.filter(company_id=company_id).first() or qs.filter(company__isnull=True).first()


def _applicable_levels(matrix: ApprovalMatrix, amount: Decimal | None, summary: dict) -> list[ApprovalLevel]:
    attrs = Attributes(resource={"amount": amount, **summary})
    levels = []
    for level in matrix.levels.select_related("role", "escalation_role").order_by("sequence"):
        if amount is not None and amount < level.min_amount:
            continue
        if amount is None and level.min_amount > 0:
            continue
        try:
            if not evaluate(level.condition, attrs):
                continue
        except ConditionError:
            pass  # a broken condition keeps the level (fail towards more approval, never less)
        levels.append(level)
    return levels


# --- Submission ---------------------------------------------------------------------------------


@transaction.atomic
def submit(
    ctx: ActorContext,
    *,
    document_type: str,
    document_id: UUID,
    company_id: UUID,
    title: str,
    amount: Decimal | None = None,
    currency: str = "",
    document_number: str = "",
    summary: dict | None = None,
    scope: dict | None = None,
) -> ApprovalRequest:
    """Called by the owning module's service inside its own transaction."""
    if registry.get(document_type) is None:
        raise BusinessRuleViolation(f"{document_type} is not registered for approvals.", code="unknown_document_type")
    if ctx.user is None:
        raise BusinessRuleViolation("Approval requests need a human requester.", code="requester_required")
    if ApprovalRequest.objects.filter(
        document_type=document_type, document_id=document_id, status=ApprovalRequest.Status.PENDING
    ).exists():
        raise BusinessRuleViolation(
            "An approval request is already pending for this document.", code="approval_already_pending"
        )
    organization_id = ctx.user.organization_id
    matrix = resolve_matrix(organization_id, company_id, document_type)
    if matrix is None:
        raise BusinessRuleViolation("No approval route is configured for this document type.", code="no_approval_route")
    summary = summary or {}
    levels = _applicable_levels(matrix, amount, summary)
    if not levels:
        raise BusinessRuleViolation("The approval route has no level for this document.", code="no_approval_route")
    now = timezone.now()
    scope = {k: v for k, v in (scope or {}).items() if k in SCOPE_ATTRS and k != "company_id"}
    request = ApprovalRequest.objects.create(
        organization_id=organization_id,
        company_id=company_id,
        document_type=document_type,
        document_id=document_id,
        document_number=document_number,
        title=title,
        amount=amount,
        currency=currency,
        summary=summary,
        matrix=matrix,
        requested_by=ctx.user,
        submitted_at=now,
        current_sequence=levels[0].sequence,
        **scope,
    )
    ApprovalStep.objects.bulk_create(
        [
            ApprovalStep(
                request=request,
                sequence=level.sequence,
                name=level.name,
                role=level.role,
                is_final=index == len(levels) - 1,
                escalation_role=level.escalation_role,
                escalation_hours=level.escalation_hours,
                due_at=now + timedelta(hours=level.escalation_hours) if index == 0 and level.escalation_hours else None,
            )
            for index, level in enumerate(levels)
        ]
    )
    audit.record(
        "approvals.request.submitted",
        ctx=ctx,
        resource_type=document_type,
        resource_id=document_id,
        company_id=company_id,
        summary=title,
        changes={
            "request_id": str(request.pk),
            "amount": str(amount) if amount is not None else None,
            "levels": [lvl.name for lvl in levels],
        },
    )
    publish_event(
        "approvals.request.submitted",
        aggregate_type="approvals.approval_request",
        aggregate_id=request.pk,
        company_id=company_id,
        payload={"sequence": request.current_sequence},
    )
    return request


# --- Eligibility -----------------------------------------------------------------------------------


def document_resource(request: ApprovalRequest, *, include_amount: bool) -> pdp.Resource:
    attrs = {attr: getattr(request, attr) for attr in SCOPE_ATTRS}
    attrs.update(
        id=request.document_id,
        created_by_id=request.requested_by_id,
        currency=request.currency or None,
        status="submitted",
    )
    if include_amount and request.amount is not None:
        attrs["amount"] = request.amount
    scope_fields = {attr.removesuffix("_id"): attr for attr in SCOPE_ATTRS}
    return pdp.Resource.ref(request.document_type, scope_fields=scope_fields, **attrs)


def current_step(request: ApprovalRequest) -> ApprovalStep | None:
    return request.steps.filter(sequence=request.current_sequence, status=ApprovalStep.Status.PENDING).first()


def holds_step_role(user_id, request: ApprovalRequest, step: ApprovalStep) -> bool:
    """The user holds the step's role through an assignment whose scope covers the document."""
    snapshot = get_snapshot(user_id)
    scope_values = document_resource(request, include_amount=False).scope_values()
    for grants in snapshot.grants.values():
        for grant in grants:
            if grant.role_id == step.role_id and grant.scope.matches(scope_values):
                return True
    return False


def _active_delegators(user: User, document_type: str) -> list[User]:
    now = timezone.now()
    qs = (
        ApprovalDelegation.objects.filter(
            delegate=user, revoked_at__isnull=True, valid_from__lte=now, valid_until__gt=now
        )
        .filter(Q(document_types=[]) | Q(document_types__contains=[document_type]))
        .select_related("delegator")
    )
    return [d.delegator for d in qs if d.delegator.is_active]


def _already_decided(request: ApprovalRequest, user_id) -> bool:
    return (
        request.steps.filter(Q(decided_by_id=user_id) | Q(acting_for_id=user_id))
        .exclude(status=ApprovalStep.Status.PENDING)
        .exists()
    )


def resolve_authority(ctx: ActorContext, request: ApprovalRequest, step: ApprovalStep) -> User | None:
    """Return the user whose authority `ctx.user` acts with (self or a delegator), or None."""
    user = ctx.user
    if user.pk == request.requested_by_id:
        return None
    if holds_step_role(user.pk, request, step):
        return user
    for delegator in _active_delegators(user, request.document_type):
        if delegator.pk != request.requested_by_id and holds_step_role(delegator.pk, request, step):
            return delegator
    return None


def eligible_users(request: ApprovalRequest, step: ApprovalStep) -> list[User]:
    """Users (and their active delegates) who may act on `step`, for notifications."""
    now = timezone.now()
    holders = User.objects.filter(
        pk__in=RoleAssignment.objects.filter(role_id=step.role_id, revoked_at__isnull=True)
        .exclude(valid_until__lte=now)
        .exclude(valid_from__gt=now)
        .values("user_id"),
        is_active=True,
    ).exclude(pk=request.requested_by_id)
    users = [u for u in holders if holds_step_role(u.pk, request, step)]
    delegates = User.objects.filter(
        pk__in=ApprovalDelegation.objects.filter(
            delegator__in=users, revoked_at__isnull=True, valid_from__lte=now, valid_until__gt=now
        )
        .filter(Q(document_types=[]) | Q(document_types__contains=[request.document_type]))
        .values("delegate_id"),
        is_active=True,
    ).exclude(pk=request.requested_by_id)
    return list({u.pk: u for u in [*users, *delegates]}.values())


def users_with_role_in_scope(role: Role, request: ApprovalRequest) -> list[User]:
    step = ApprovalStep(role=role, request=request)
    return [
        u
        for u in User.objects.filter(
            pk__in=RoleAssignment.objects.filter(role=role, revoked_at__isnull=True).values("user_id"), is_active=True
        )
        if holds_step_role(u.pk, request, step)
    ]


# --- Decisions ------------------------------------------------------------------------------------


def _load_for_decision(request: ApprovalRequest, expected_version: int | None) -> ApprovalRequest:
    request = ApprovalRequest.objects.select_for_update().get(pk=request.pk)
    if request.status != ApprovalRequest.Status.PENDING:
        raise InvalidStateTransition(f"The request is already {request.status}.")
    if expected_version is not None and request.version != expected_version:
        raise VersionConflict()
    return request


@transaction.atomic
def decide(
    ctx: ActorContext,
    request: ApprovalRequest,
    *,
    approve: bool,
    comment: str = "",
    expected_version: int | None = None,
) -> ApprovalRequest:
    request = _load_for_decision(request, expected_version)
    step = current_step(request)
    if step is None:
        raise InvalidStateTransition("No step is awaiting a decision.")
    if not approve and not comment.strip():
        raise ValidationError({"comment": ["A reason is required when rejecting."]})
    if ctx.user.pk == request.requested_by_id:
        raise AuthorizationDenied(reason="self_approval")
    authority = resolve_authority(ctx, request, step)
    if authority is None:
        raise AuthorizationDenied(reason="not_an_approver_for_this_step")
    if _already_decided(request, ctx.user.pk) or _already_decided(request, authority.pk):
        raise AuthorizationDenied(reason="already_decided_another_level")

    verb = "approve" if approve else "reject"
    # Decide in the request's company context; scope grants still have to cover the document.
    authority_ctx = replace(ctx, user=authority, company_id=request.company_id)
    resource = document_resource(request, include_amount=approve and step.is_final)
    pdp.require(authority_ctx, f"{request.document_type}.{verb}", resource)

    now = timezone.now()
    step.status = ApprovalStep.Status.APPROVED if approve else ApprovalStep.Status.REJECTED
    step.decided_by = ctx.user
    step.acting_for = authority if authority.pk != ctx.user.pk else None
    step.decided_at = now
    step.comment = comment.strip()
    step.save(update_fields=["status", "decided_by", "acting_for", "decided_at", "comment"])

    doc_type = registry.get(request.document_type)
    if not approve:
        request.steps.filter(status=ApprovalStep.Status.PENDING).update(status=ApprovalStep.Status.SKIPPED)
        request.status, request.completed_at, request.current_sequence = ApprovalRequest.Status.REJECTED, now, None
        event = "approvals.request.rejected"
    else:
        next_step = request.steps.filter(status=ApprovalStep.Status.PENDING).order_by("sequence").first()
        if next_step is None:
            request.status, request.completed_at, request.current_sequence = ApprovalRequest.Status.APPROVED, now, None
            event = "approvals.request.approved"
        else:
            request.current_sequence = next_step.sequence
            if next_step.escalation_hours:
                next_step.due_at = now + timedelta(hours=next_step.escalation_hours)
                next_step.save(update_fields=["due_at"])
            event = "approvals.step.approved"
    request.version += 1
    request.save(update_fields=["status", "completed_at", "current_sequence", "version", "updated_at"])

    if request.status == ApprovalRequest.Status.APPROVED and doc_type and doc_type.on_approved:
        doc_type.on_approved(request, ctx)
    if request.status == ApprovalRequest.Status.REJECTED and doc_type and doc_type.on_rejected:
        doc_type.on_rejected(request, ctx)

    audit.record(
        f"approvals.step.{'approved' if approve else 'rejected'}",
        ctx=ctx,
        resource_type=request.document_type,
        resource_id=request.document_id,
        company_id=request.company_id,
        summary=f"{step.name}: {request.title}",
        changes={
            "request_id": str(request.pk),
            "step": step.sequence,
            "comment": step.comment,
            "acting_for": str(authority.pk) if step.acting_for_id else None,
            "request_status": request.status,
        },
    )
    publish_event(
        event,
        aggregate_type="approvals.approval_request",
        aggregate_id=request.pk,
        company_id=request.company_id,
        payload={"step": step.sequence, "decided_by": str(ctx.user.pk), "status": request.status},
    )
    return request


@transaction.atomic
def withdraw(
    ctx: ActorContext, request: ApprovalRequest, *, reason: str = "", expected_version: int | None = None
) -> ApprovalRequest:
    request = _load_for_decision(request, expected_version)
    if request.requested_by_id != ctx.user.pk:
        raise AuthorizationDenied(reason="only_requester_can_withdraw")
    now = timezone.now()
    request.steps.filter(status=ApprovalStep.Status.PENDING).update(status=ApprovalStep.Status.SKIPPED)
    request.status, request.completed_at, request.current_sequence = ApprovalRequest.Status.WITHDRAWN, now, None
    request.version += 1
    request.save(update_fields=["status", "completed_at", "current_sequence", "version", "updated_at"])
    doc_type = registry.get(request.document_type)
    if doc_type and doc_type.on_withdrawn:
        doc_type.on_withdrawn(request, ctx)
    audit.record(
        "approvals.request.withdrawn",
        ctx=ctx,
        resource_type=request.document_type,
        resource_id=request.document_id,
        company_id=request.company_id,
        summary=reason[:500],
    )
    publish_event(
        "approvals.request.withdrawn",
        aggregate_type="approvals.approval_request",
        aggregate_id=request.pk,
        company_id=request.company_id,
    )
    return request


# --- Queries ---------------------------------------------------------------------------------------


def inbox(ctx: ActorContext) -> list[ApprovalRequest]:
    """Pending requests whose current step the caller may decide (directly or as a delegate)."""
    user = ctx.user
    snapshot = get_snapshot(user.pk)
    role_ids = {g.role_id for grants in snapshot.grants.values() for g in grants}
    delegators = _active_delegator_ids(user)
    for delegator_id in delegators:
        role_ids |= {g.role_id for grants in get_snapshot(delegator_id).grants.values() for g in grants}
    if not role_ids:
        return []
    candidates = (
        ApprovalRequest.objects.filter(
            status=ApprovalRequest.Status.PENDING,
            steps__status=ApprovalStep.Status.PENDING,
            steps__role_id__in=role_ids,
        )
        .exclude(requested_by=user)
        .select_related("requested_by")
        .distinct()
        .order_by("submitted_at")
    )
    if ctx.company_id:
        candidates = candidates.filter(company_id=ctx.company_id)
    result = []
    for request in candidates:
        step = current_step(request)
        if step is None or _already_decided(request, user.pk):
            continue
        if resolve_authority(ctx, request, step) is not None:
            request.current_step_obj = step
            result.append(request)
    return result


def _active_delegator_ids(user: User) -> set:
    now = timezone.now()
    return set(
        ApprovalDelegation.objects.filter(
            delegate=user, revoked_at__isnull=True, valid_from__lte=now, valid_until__gt=now
        ).values_list("delegator_id", flat=True)
    )


def visible_requests_q(ctx: ActorContext, inbox_ids: list | None = None) -> Q:
    """Requester, past deciders, current eligible approvers, plus oversight readers in scope."""
    q = Q(requested_by=ctx.user) | Q(steps__decided_by=ctx.user) | Q(steps__acting_for=ctx.user)
    if inbox_ids:
        q |= Q(pk__in=inbox_ids)
    oversight = pdp.scope_q(ctx, "approvals.approval_request.read", ApprovalRequest)
    if oversight is not None:
        q |= oversight
    return q


# --- Delegation ------------------------------------------------------------------------------------


@transaction.atomic
def create_delegation(
    ctx: ActorContext, *, delegate: User, valid_from, valid_until, reason: str, document_types: list[str] | None = None
) -> ApprovalDelegation:
    if delegate.pk == ctx.user.pk:
        raise ValidationError({"delegate": ["You cannot delegate to yourself."]})
    if delegate.organization_id != ctx.user.organization_id or not delegate.is_active:
        raise ValidationError({"delegate": ["Choose an active user in your organization."]})
    if valid_until <= valid_from:
        raise ValidationError({"valid_until": ["Must be after valid_from."]})
    if valid_until - valid_from > timedelta(days=90):
        raise ValidationError({"valid_until": ["Delegations are limited to 90 days."]})
    delegation = ApprovalDelegation.objects.create(
        organization_id=ctx.user.organization_id,
        delegator=ctx.user,
        delegate=delegate,
        document_types=document_types or [],
        valid_from=valid_from,
        valid_until=valid_until,
        reason=reason,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        "approvals.delegation.created",
        ctx=ctx,
        resource_type="approvals.delegation",
        resource_id=delegation.pk,
        changes={
            "delegate": str(delegate.pk),
            "from": valid_from.isoformat(),
            "until": valid_until.isoformat(),
            "document_types": document_types or [],
        },
    )
    return delegation


@transaction.atomic
def revoke_delegation(ctx: ActorContext, delegation: ApprovalDelegation) -> ApprovalDelegation:
    if delegation.delegator_id != ctx.user.pk:
        raise AuthorizationDenied(reason="only_delegator_can_revoke")
    if delegation.revoked_at is None:
        delegation.revoked_at = timezone.now()
        delegation.updated_by = ctx.user
        delegation.save(update_fields=["revoked_at", "updated_by", "updated_at"])
        audit.record(
            "approvals.delegation.revoked", ctx=ctx, resource_type="approvals.delegation", resource_id=delegation.pk
        )
    return delegation


# --- Escalation ------------------------------------------------------------------------------------


def escalate_overdue(now=None) -> int:
    """Mark overdue current steps as escalated and emit events (notifications are side effects)."""
    now = now or timezone.now()
    count = 0
    with transaction.atomic():
        steps = (
            ApprovalStep.objects.select_for_update(skip_locked=True)
            .filter(
                status=ApprovalStep.Status.PENDING,
                escalated_at__isnull=True,
                due_at__lte=now,
                request__status=ApprovalRequest.Status.PENDING,
            )
            .select_related("request")
        )
        for step in steps:
            if step.request.current_sequence != step.sequence:
                continue
            step.escalated_at = now
            step.save(update_fields=["escalated_at"])
            audit.record(
                "approvals.step.escalated",
                ctx=ActorContext.system("approval_escalation"),
                resource_type=step.request.document_type,
                resource_id=step.request.document_id,
                company_id=step.request.company_id,
                summary=f"{step.name}: {step.request.title}",
            )
            publish_event(
                "approvals.step.escalated",
                aggregate_type="approvals.approval_request",
                aggregate_id=step.request_id,
                company_id=step.request.company_id,
                payload={"step": step.sequence},
            )
            count += 1
    return count
