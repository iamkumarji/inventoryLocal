"""Authorization administration services. Every change is audited and authorized."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.core.context import ActorContext
from apps.core.exceptions import BusinessRuleViolation, VersionConflict
from apps.identity.models import User

from . import conditions, pdp
from .models import AbacPolicy, ApprovalLimit, Permission, Role, RoleAssignment, RolePermission, ScopeType, SodRule
from .snapshot import get_store

ROLE_FIELDS = ("code", "name", "description", "is_active", "max_session_minutes", "mfa_required")
POLICY_FIELDS = ("code", "description", "effect", "priority", "actions", "resource_types", "condition", "is_active")


def _check_version(instance, expected: int | None) -> None:
    if expected is not None and instance.version != expected:
        raise VersionConflict()


def _require_editable_role(role: Role) -> None:
    if role.is_system_template:
        raise BusinessRuleViolation(
            "Role templates are read-only. Clone the template to customise it.", code="role_template_read_only"
        )


# --- Roles ----------------------------------------------------------------------------


@transaction.atomic
def create_role(
    ctx: ActorContext,
    *,
    organization,
    code: str,
    name: str,
    description: str = "",
    permission_codes: list[str] | None = None,
    max_session_minutes: int | None = None,
    mfa_required: bool = False,
) -> Role:
    pdp.require(
        ctx, "authorization.role.create", pdp.Resource.ref("authorization.role", organization_id=organization.pk)
    )
    if Role.objects.filter(organization=organization, code=code).exists():
        raise ValidationError({"code": ["A role with this code already exists."]})
    role = Role.objects.create(
        organization=organization,
        code=code,
        name=name,
        description=description,
        max_session_minutes=max_session_minutes,
        mfa_required=mfa_required,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    if permission_codes:
        _set_permissions(role, permission_codes)
    audit.record(
        "authorization.role.created",
        ctx=ctx,
        resource_type="authorization.role",
        resource_id=role.pk,
        changes={"after": audit.snapshot(role, ROLE_FIELDS), "permissions": sorted(permission_codes or [])},
    )
    return role


@transaction.atomic
def update_role(ctx: ActorContext, role: Role, data: dict, expected_version: int | None) -> Role:
    role = Role.objects.select_for_update().get(pk=role.pk)
    pdp.require(ctx, "authorization.role.update", pdp.Resource.of(role))
    _require_editable_role(role)
    _check_version(role, expected_version)
    before = audit.snapshot(role, ROLE_FIELDS)
    for field in ("name", "description", "is_active", "max_session_minutes", "mfa_required"):
        if field in data:
            setattr(role, field, data[field])
    role.version += 1
    role.updated_by = ctx.user
    role.save()
    changes = audit.diff(before, audit.snapshot(role, ROLE_FIELDS))
    audit.record(
        "authorization.role.updated", ctx=ctx, resource_type="authorization.role", resource_id=role.pk, changes=changes
    )
    return role


def _set_permissions(role: Role, codes: list[str]) -> tuple[set[str], set[str]]:
    codes = set(codes)
    found = dict(Permission.objects.filter(code__in=codes, is_active=True).values_list("code", "id"))
    unknown = codes - set(found)
    if unknown:
        raise ValidationError({"permission_codes": [f"Unknown permission(s): {', '.join(sorted(unknown))}"]})
    current = set(role.role_permissions.values_list("permission__code", flat=True))
    added, removed = codes - current, current - codes
    RolePermission.objects.filter(role=role, permission__code__in=removed).delete()
    RolePermission.objects.bulk_create([RolePermission(role=role, permission_id=found[c]) for c in added])
    return added, removed


@transaction.atomic
def set_role_permissions(ctx: ActorContext, role: Role, codes: list[str], expected_version: int | None) -> Role:
    role = Role.objects.select_for_update().get(pk=role.pk)
    pdp.require(ctx, "authorization.role.manage", pdp.Resource.of(role))
    _require_editable_role(role)
    _check_version(role, expected_version)
    added, removed = _set_permissions(role, codes)
    _check_sod_for_role_members(role)
    role.version += 1
    role.updated_by = ctx.user
    role.save(update_fields=["version", "updated_by", "updated_at"])
    audit.record(
        "authorization.role.permissions_changed",
        ctx=ctx,
        resource_type="authorization.role",
        resource_id=role.pk,
        changes={"added": sorted(added), "removed": sorted(removed)},
    )
    return role


@transaction.atomic
def clone_role(ctx: ActorContext, source: Role, *, code: str, name: str) -> Role:
    codes = list(source.role_permissions.values_list("permission__code", flat=True))
    return create_role(
        ctx,
        organization=source.organization,
        code=code,
        name=name,
        description=f"Cloned from {source.code}. {source.description}".strip(),
        permission_codes=codes,
        max_session_minutes=source.max_session_minutes,
        mfa_required=source.mfa_required,
    )


# --- Assignments ------------------------------------------------------------------------


def _scope_company(scope_type: str, scope_id) -> object | None:
    tree = get_store().tree
    if tree.nodes.get(scope_id) != scope_type:
        raise ValidationError({"scope_id": [f"No {scope_type} exists with this id."]})
    if scope_type == ScopeType.ORGANIZATION:
        return None
    if scope_type == ScopeType.COMPANY:
        return scope_id
    return tree.company_of.get(scope_id)


def user_permission_codes(user_id, extra_role: Role | None = None) -> set[str]:
    now = timezone.now()
    role_ids = set(
        RoleAssignment.objects.filter(user_id=user_id, revoked_at__isnull=True, role__is_active=True)
        .exclude(valid_until__lte=now)
        .values_list("role_id", flat=True)
    )
    if extra_role is not None:
        role_ids.add(extra_role.pk)
    return set(RolePermission.objects.filter(role_id__in=role_ids).values_list("permission__code", flat=True))


def sod_conflicts_for(codes: set[str]) -> list[dict]:
    conflicts = []
    for rule_code, a, b in get_store().sod_same_user:
        if a in codes and b in codes:
            conflicts.append({"rule": rule_code, "permission_a": a, "permission_b": b})
    return conflicts


def _check_sod_for_role_members(role: Role) -> None:
    for user_id in role.assignments.filter(revoked_at__isnull=True).values_list("user_id", flat=True).distinct():
        conflicts = sod_conflicts_for(user_permission_codes(user_id))
        if conflicts:
            raise BusinessRuleViolation(
                "This change would give a user conflicting duties.",
                code="sod_conflict",
                meta={"user_id": str(user_id), "conflicts": conflicts},
            )


@transaction.atomic
def assign_role(
    ctx: ActorContext,
    *,
    user: User,
    role: Role,
    scope_type: str,
    scope_id,
    include_descendants: bool = True,
    valid_from: datetime | None = None,
    valid_until: datetime | None = None,
    reason: str = "",
) -> RoleAssignment:
    if scope_type not in ScopeType.values:
        raise ValidationError({"scope_type": ["Invalid scope type."]})
    company_id = _scope_company(scope_type, scope_id)
    if role.organization_id != user.organization_id:
        raise ValidationError({"role": ["Role belongs to a different organization."]})
    if not role.is_active:
        raise ValidationError({"role": ["Role is inactive."]})
    pdp.require(
        ctx,
        "authorization.role_assignment.assign",
        pdp.Resource.ref("authorization.role_assignment", organization_id=role.organization_id, company_id=company_id),
    )
    if user.pk == ctx.user_id:
        raise BusinessRuleViolation("You cannot grant roles to yourself.", code="self_grant")
    conflicts = sod_conflicts_for(user_permission_codes(user.pk, extra_role=role))
    if conflicts:
        raise BusinessRuleViolation(
            "This assignment would give the user conflicting duties.",
            code="sod_conflict",
            meta={"conflicts": conflicts},
        )
    assignment = RoleAssignment.objects.create(
        user=user,
        role=role,
        organization_id=role.organization_id,
        scope_type=scope_type,
        scope_id=scope_id,
        company_id=company_id,
        include_descendants=include_descendants,
        valid_from=valid_from,
        valid_until=valid_until,
        reason=reason,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        "authorization.role.assigned",
        ctx=ctx,
        resource_type="authorization.role_assignment",
        resource_id=assignment.pk,
        company_id=company_id,
        changes={
            "user": str(user.pk),
            "role": role.code,
            "scope_type": scope_type,
            "scope_id": str(scope_id),
            "include_descendants": include_descendants,
            "valid_until": valid_until.isoformat() if valid_until else None,
            "reason": reason,
        },
    )
    return assignment


@transaction.atomic
def revoke_assignment(ctx: ActorContext, assignment: RoleAssignment, reason: str = "") -> RoleAssignment:
    assignment = RoleAssignment.objects.select_for_update().get(pk=assignment.pk)
    pdp.require(ctx, "authorization.role_assignment.assign", pdp.Resource.of(assignment))
    if assignment.revoked_at is not None:
        raise BusinessRuleViolation("Assignment is already revoked.", code="already_revoked")
    assignment.revoked_at = timezone.now()
    assignment.revoked_by = ctx.user
    assignment.updated_by = ctx.user
    assignment.save(update_fields=["revoked_at", "revoked_by", "updated_by", "updated_at"])
    audit.record(
        "authorization.role.revoked",
        ctx=ctx,
        resource_type="authorization.role_assignment",
        resource_id=assignment.pk,
        company_id=assignment.company_id,
        changes={"user": str(assignment.user_id), "role": assignment.role.code, "reason": reason},
    )
    return assignment


# --- ABAC policies ------------------------------------------------------------------------


def validate_policy_payload(data: dict) -> list[str]:
    errors = conditions.validate(data.get("condition"))
    actions = data.get("actions") or []
    if not actions:
        errors.append("actions: at least one action pattern is required")
    for pattern in actions:
        parts = str(pattern).split(".")
        if len(parts) != 3 or not all(parts):
            errors.append(f"actions: invalid pattern {pattern!r} (expected module.resource.action, '*' allowed)")
    if data.get("effect") not in ("allow", "deny"):
        errors.append("effect: must be 'allow' or 'deny'")
    if data.get("effect") == "allow" and not data.get("condition"):
        errors.append("condition: allow policies must have a condition (unconditional grants belong in roles)")
    return errors


@transaction.atomic
def save_policy(
    ctx: ActorContext,
    *,
    organization,
    data: dict,
    policy: AbacPolicy | None = None,
    expected_version: int | None = None,
) -> AbacPolicy:
    errors = validate_policy_payload(data)
    if errors:
        raise ValidationError({"policy": errors})
    if policy is None:
        pdp.require(
            ctx,
            "authorization.policy.manage",
            pdp.Resource.ref("authorization.policy", organization_id=organization.pk),
        )
        policy = AbacPolicy(organization=organization, created_by=ctx.user)
        before = {}
    else:
        policy = AbacPolicy.objects.select_for_update().get(pk=policy.pk)
        pdp.require(ctx, "authorization.policy.manage", pdp.Resource.of(policy))
        _check_version(policy, expected_version)
        before = audit.snapshot(policy, POLICY_FIELDS)
        policy.version += 1
    for field in POLICY_FIELDS:
        if field in data:
            setattr(policy, field, data[field])
    policy.updated_by = ctx.user
    policy.save()
    audit.record(
        "authorization.policy.saved",
        ctx=ctx,
        resource_type="authorization.policy",
        resource_id=policy.pk,
        changes=audit.diff(before, audit.snapshot(policy, POLICY_FIELDS)),
    )
    return policy


# --- SoD rules and approval limits ---------------------------------------------------------


@transaction.atomic
def create_sod_rule(
    ctx: ActorContext,
    *,
    organization,
    code: str,
    permission_a: str,
    permission_b: str,
    mode: str,
    description: str = "",
) -> SodRule:
    pdp.require(
        ctx,
        "authorization.sod_rule.manage",
        pdp.Resource.ref("authorization.sod_rule", organization_id=organization.pk),
    )
    perms = {p.code: p for p in Permission.objects.filter(code__in=[permission_a, permission_b])}
    missing = {permission_a, permission_b} - set(perms)
    if missing:
        raise ValidationError({"permissions": [f"Unknown permission(s): {', '.join(sorted(missing))}"]})
    rule = SodRule.objects.create(
        organization=organization,
        code=code,
        description=description,
        mode=mode,
        permission_a=perms[permission_a],
        permission_b=perms[permission_b],
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        "authorization.sod_rule.created",
        ctx=ctx,
        resource_type="authorization.sod_rule",
        resource_id=rule.pk,
        changes={"a": permission_a, "b": permission_b, "mode": mode},
    )
    return rule


@transaction.atomic
def set_approval_limit(
    ctx: ActorContext, *, organization, role: Role, document_type: str, currency: str, max_amount: Decimal, company=None
) -> ApprovalLimit:
    pdp.require(
        ctx,
        "authorization.approval_limit.manage",
        pdp.Resource.ref("authorization.approval_limit", organization_id=organization.pk),
    )
    if max_amount < 0:
        raise ValidationError({"max_amount": ["Must be zero or more."]})
    limit, created = ApprovalLimit.objects.select_for_update().get_or_create(
        role=role,
        document_type=document_type,
        currency=currency,
        company=company,
        defaults={
            "organization": organization,
            "max_amount": max_amount,
            "created_by": ctx.user,
            "updated_by": ctx.user,
        },
    )
    before = None if created else str(limit.max_amount)
    if not created:
        limit.max_amount, limit.is_active, limit.updated_by = max_amount, True, ctx.user
        limit.save()
    audit.record(
        "authorization.approval_limit.set",
        ctx=ctx,
        resource_type="authorization.approval_limit",
        resource_id=limit.pk,
        company_id=company.pk if company else None,
        changes={
            "role": role.code,
            "document_type": document_type,
            "currency": currency,
            "max_amount": {"from": before, "to": str(max_amount)},
        },
    )
    return limit


def sod_conflict_report(organization) -> list[dict]:
    """Users currently holding conflicting permissions (same_user_any rules)."""
    by_user: dict = defaultdict(set)
    rows = RoleAssignment.objects.filter(organization=organization, revoked_at__isnull=True, role__is_active=True)
    for user_id, code in rows.values_list("user_id", "role__role_permissions__permission__code"):
        if code:
            by_user[user_id].add(code)
    report = []
    for user_id, codes in by_user.items():
        for conflict in sod_conflicts_for(codes):
            report.append({"user_id": str(user_id), **conflict})
    return report
