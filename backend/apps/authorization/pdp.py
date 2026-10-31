"""Policy Decision Point (docs/RBAC_ABAC.md §4).

Default deny. RBAC grants (scoped role assignments) or ABAC allow policies can
grant; ABAC deny policies and built-in guards override any grant.
"""

from __future__ import annotations

import ipaddress
import logging
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from functools import lru_cache
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db.models import Model, Q, QuerySet
from django.utils import timezone

from apps.core import flags
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, MFARequired

from .conditions import Attributes, ConditionError, evaluate, references_resource, to_q
from .scopes import finer_levels
from .snapshot import Grant, PolicyInfo, PolicyStore, SubjectSnapshot, get_snapshot, get_store

logger = logging.getLogger("erp.security")

_FALSE_Q = Q(pk__in=[])


@dataclass(frozen=True)
class Resource:
    type: str
    attrs: dict[str, Any]
    scope_fields: dict[str, str] = field(default_factory=dict)

    @classmethod
    def of(cls, obj: Model) -> Resource:
        return cls(obj.authz_resource_type, obj.authz_attributes(), dict(obj.authz_scope_fields))

    @classmethod
    def ref(cls, type_: str, scope_fields: dict[str, str] | None = None, **attrs: Any) -> Resource:
        """A resource that doesn't exist yet (create checks) or a non-model resource."""
        if scope_fields is None:
            scope_fields = {
                level: f"{level}_id"
                for level in ("organization", "company", "branch", "facility", "warehouse", "department")
                if f"{level}_id" in attrs
            }
        return cls(type_, {"type": type_, **attrs}, scope_fields)

    def scope_values(self) -> dict[str, Any]:
        return {level: self.attrs.get(attr) for level, attr in self.scope_fields.items()}


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str
    policy: str | None = None
    obligations: frozenset = frozenset()

    def __bool__(self) -> bool:
        return self.allowed


ALLOW_SYSTEM = Decision(True, "system")


def _deny(reason: str, policy: str | None = None) -> Decision:
    return Decision(False, reason, policy)


@lru_cache(maxsize=1)
def _internal_networks() -> tuple:
    return tuple(ipaddress.ip_network(n, strict=False) for n in settings.ERP["INTERNAL_NETWORKS"])


def _is_internal(ip: str | None) -> bool | None:
    if not ip:
        return None
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in _internal_networks())


def _verb(action: str) -> str:
    return action.rsplit(".", 1)[-1]


def _resource_type(action: str) -> str:
    return action.rsplit(".", 1)[0]


class _Evaluation:
    """Holds per-call state so lazily computed attributes (approval limit) are reused."""

    def __init__(
        self, ctx: ActorContext, action: str, resource: Resource | None, store: PolicyStore, snapshot: SubjectSnapshot
    ):
        self.ctx, self.action, self.resource, self.store, self.snapshot = ctx, action, resource, store, snapshot
        self.rbac: list[Grant] = []

    def company_tz_now(self) -> datetime:
        return timezone.localtime(timezone.now(), ZoneInfo(settings.TIME_ZONE))

    def attributes(self) -> Attributes:
        user = self.ctx.user
        now = self.company_tz_now()
        resource_attrs = dict(self.resource.attrs) if self.resource else {}
        return Attributes(
            subject={
                "id": user.pk if user else None,
                "is_active": getattr(user, "is_active", False),
                "role_codes": sorted(self.snapshot.role_codes),
                "employee_id": getattr(user, "employee_id", None),
                "organization_id": getattr(user, "organization_id", None),
                "mfa_verified": self.ctx.mfa_verified_at is not None,
                "session_client_type": self.ctx.client_type,
            },
            resource=resource_attrs,
            action={"code": self.action, "verb": _verb(self.action)},
            env={
                "now": now.isoformat(),
                "time": now.strftime("%H:%M"),
                "weekday": now.isoweekday(),
                "ip": self.ctx.ip,
                "ip_internal": lambda: _is_internal(self.ctx.ip),
                "client_type": self.ctx.client_type,
                "company_id": self.ctx.company_id,
                "approval_limit": self.approval_limit,
            },
        )

    def approval_limit(self) -> Decimal | None:
        if self.resource is None:
            return None
        company_id = self.resource.attrs.get("company_id") or self.ctx.company_id
        currency = self.resource.attrs.get("currency") or self.store.tree.company_currency.get(company_id)
        best: Decimal | None = None
        for role_id in {g.role_id for g in self.rbac}:
            for limit_company, amount in self.store.approval_limits.get((role_id, self.resource.type, currency), ()):
                if limit_company is None or limit_company == company_id:
                    best = amount if best is None else max(best, amount)
        return best

    def policies(self, effect: str) -> list[PolicyInfo]:
        source = self.store.allow_policies if effect == "allow" else self.store.deny_policies
        org_id = getattr(self.ctx.user, "organization_id", None)
        rtype = self.resource.type if self.resource else _resource_type(self.action)
        return [p for p in source if p.organization_id == org_id and p.targets(self.action, rtype)]


def _in_mfa_grace(user) -> bool:
    from apps.identity.services import in_mfa_grace  # identity sits below authorization

    return in_mfa_grace(user)


def _step_up_required(user) -> bool:
    """Organizations may turn off the second check before MFA-marked actions (default: required)."""
    if not user.organization_id:
        return True
    return user.organization.require_mfa_for_sensitive_actions


def _pre_checks(ctx: ActorContext, action: str) -> tuple[Decision | None, PolicyStore | None, SubjectSnapshot | None]:
    user = ctx.user
    if user is None or not user.is_active or not user.pk:
        return _deny("inactive_subject"), None, None
    store = get_store()
    if action not in store.permissions:
        return _deny("unknown_permission"), None, None
    snapshot = get_snapshot(user.pk)
    module = action.split(".", 1)[0]
    if module not in settings.ERP["ALWAYS_ON_MODULES"] and not flags.is_enabled(
        flags.module_flag_key(module),
        user_id=user.pk,
        role_codes=snapshot.role_codes,
        company_id=ctx.company_id,
        organization_id=user.organization_id,
    ):
        return _deny("feature_disabled"), store, snapshot
    if snapshot.mfa_required and ctx.mfa_verified_at is None and not _in_mfa_grace(user):
        return _deny("mfa_required"), store, snapshot
    if (
        store.permissions[action].requires_mfa
        and _step_up_required(user)
        and not ctx.mfa_verified_within(settings.ERP["STEP_UP_MINUTES"])
    ):
        return _deny("mfa_required"), store, snapshot
    return None, store, snapshot


def authorize(ctx: ActorContext, action: str, resource: Resource | None = None) -> Decision:
    if ctx.is_system:
        return ALLOW_SYSTEM
    decision, store, snapshot = _pre_checks(ctx, action)
    if decision is not None:
        _log(ctx, action, resource, decision)
        return decision
    ev = _Evaluation(ctx, action, resource, store, snapshot)

    # Company isolation: records of another company are never reachable from the active company context.
    if resource is not None and ctx.company_id is not None:
        resource_company = resource.attrs.get("company_id")
        if resource_company is not None and resource_company != ctx.company_id:
            return _log(ctx, action, resource, _deny("company_context_mismatch"))

    grants = snapshot.grants.get(action, ())
    if resource is None or not resource.scope_fields:
        ev.rbac = list(grants)
    else:
        scope_values = resource.scope_values()
        ev.rbac = [g for g in grants if g.scope.matches(scope_values)]

    attrs = ev.attributes()
    allowed_by_policy = None
    if not ev.rbac and resource is not None:
        for policy in ev.policies("allow"):
            try:
                if evaluate(policy.condition, attrs):
                    allowed_by_policy = policy.code
                    break
            except ConditionError:
                logger.warning("allow policy condition error", extra={"policy": policy.code})
    if not ev.rbac and allowed_by_policy is None:
        return _log(ctx, action, resource, _deny("no_grant"))

    for policy in ev.policies("deny"):
        try:
            matched = evaluate(policy.condition, attrs)
        except ConditionError:
            matched = True  # fail closed
        if matched:
            return _log(ctx, action, resource, _deny("policy", policy.code))

    if resource is not None:
        guard = _guards(ev, attrs)
        if guard is not None:
            return _log(ctx, action, resource, guard)

    obligations = frozenset({"audit_access"}) if store.permissions[action].is_sensitive else frozenset()
    return Decision(True, "rbac" if ev.rbac else "policy", allowed_by_policy, obligations)


def _guards(ev: _Evaluation, attrs: Attributes) -> Decision | None:
    resource, ctx, action = ev.resource, ev.ctx, ev.action
    user_id = ctx.user.pk
    verb = _verb(action)
    makers = {resource.attrs.get("created_by_id"), resource.attrs.get("submitted_by_id")} - {None}

    if verb == "approve" and user_id in makers:
        self_code = f"{_resource_type(action)}.self_approve"
        exception = [g for g in ev.snapshot.grants.get(self_code, ()) if g.scope.matches(resource.scope_values())]
        if not exception or not ctx.mfa_verified_within(settings.ERP["STEP_UP_MINUTES"]):
            return _deny("self_approval")

    if verb == "approve" and resource.attrs.get("amount") is not None:
        limit = attrs.get("env.approval_limit")
        if limit is None or Decimal(str(resource.attrs["amount"])) > limit:
            return _deny("approval_limit")

    history: dict[str, set] = {k: set(v) for k, v in (resource.attrs.get("action_history") or {}).items()}
    if resource.attrs.get("created_by_id"):
        history.setdefault(f"{resource.type}.create", set()).add(resource.attrs["created_by_id"])
    for rule_code, other in ev.store.sod_same_record.get(action, ()):
        if user_id in history.get(other, set()):
            return _deny("sod", rule_code)
    return None


def _log(ctx: ActorContext, action: str, resource: Resource | None, decision: Decision) -> Decision:
    if not decision.allowed:
        logger.info(
            "authz deny",
            extra={
                "action": action,
                "reason": decision.reason,
                "policy": decision.policy,
                "resource_type": resource.type if resource else None,
                "resource_id": str(resource.attrs.get("id")) if resource and resource.attrs.get("id") else None,
                "subject_id": str(ctx.user_id) if ctx.user_id else None,
            },
        )
    return decision


def require(ctx: ActorContext, action: str, resource: Resource | None = None) -> Decision:
    decision = authorize(ctx, action, resource)
    if not decision.allowed:
        if decision.reason == "mfa_required":
            raise MFARequired()
        # SoD denials carry the rule code in `policy` but must surface as "sod" (an explained refusal);
        # the rule code itself is in the decision log.
        explained_sod = decision.reason == "sod"
        raise AuthorizationDenied(
            reason=decision.reason if explained_sod or not decision.policy else f"policy:{decision.policy}"
        )
    return decision


def can(ctx: ActorContext, action: str, resource: Resource | None = None) -> bool:
    return authorize(ctx, action, resource).allowed


def has_any_grant(ctx: ActorContext, action: str) -> Decision:
    """Endpoint-level check: could the subject perform `action` on at least some resource?"""
    if ctx.is_system:
        return ALLOW_SYSTEM
    decision, store, snapshot = _pre_checks(ctx, action)
    if decision is not None:
        return _log(ctx, action, None, decision)
    ev = _Evaluation(ctx, action, None, store, snapshot)
    if not snapshot.grants.get(action) and not ev.policies("allow"):
        return _log(ctx, action, None, _deny("no_grant"))
    attrs = ev.attributes()
    for policy in ev.policies("deny"):
        if references_resource(policy.condition):
            continue  # decided per object / per row
        try:
            matched = evaluate(policy.condition, attrs)
        except ConditionError:
            matched = True
        if matched:
            return _log(ctx, action, None, _deny("policy", policy.code))
    return Decision(True, "possible")


def _field_resolver(model: type[Model]):
    names = {f.name: f for f in model._meta.get_fields() if getattr(f, "concrete", False)}
    attnames = {f.attname: f for f in names.values()}

    def resolve(attr: str) -> str | None:
        if attr in attnames:
            return attr
        if attr in names:
            return attr
        return None

    return resolve


def scope_q(ctx: ActorContext, action: str, model: type[Model]) -> Q | None:
    """Row filter for list endpoints. None means nothing is visible."""
    if ctx.is_system:
        return Q()
    decision, store, snapshot = _pre_checks(ctx, action)
    if decision is not None:
        return None
    ev = _Evaluation(ctx, action, None, store, snapshot)
    ev.resource = Resource.ref(getattr(model, "authz_resource_type", _resource_type(action)), scope_fields={})
    attrs = ev.attributes()
    fields = getattr(model, "authz_scope_fields", {}) or {}
    resolve = _field_resolver(model)

    grants = snapshot.grants.get(action, ())
    if not grants:
        q_grant = _FALSE_Q
    elif not fields:
        q_grant = Q()
    else:
        q_grant = _FALSE_Q
        for grant in grants:
            for level, field_name in fields.items():
                ids = grant.scope.ids(level)
                if not ids:
                    continue
                q_level = Q(**{f"{field_name}__in": ids})
                if level in grant.scope.exact:
                    for finer in finer_levels(level):
                        if finer in fields:
                            q_level &= Q(**{f"{fields[finer]}__isnull": True})
                q_grant |= q_level

    for policy in ev.policies("allow"):
        q_policy = to_q(policy.condition, attrs, resolve)
        if q_policy is not None:
            q_grant |= q_policy

    q = q_grant
    for policy in ev.policies("deny"):
        q_deny = to_q(policy.condition, attrs, resolve)
        if q_deny is None:
            logger.error("deny policy not translatable to a row filter; failing closed", extra={"policy": policy.code})
            return None
        q &= ~q_deny

    if ctx.company_id is not None and fields.get("company") == "company_id":
        # Rows of other companies are hidden; organization-level rows (nullable company) stay
        # visible but only through an organization-level grant matched above.
        company_field = next((f for f in model._meta.concrete_fields if f.attname == "company_id"), None)
        context_q = Q(company_id=ctx.company_id)
        if company_field is not None and company_field.null:
            context_q |= Q(company_id__isnull=True)
        q &= context_q
    return q


def filter_queryset(ctx: ActorContext, action: str, queryset: QuerySet) -> QuerySet:
    q = scope_q(ctx, action, queryset.model)
    if q is None:
        return queryset.none()
    return queryset.filter(q)


def effective_permissions(ctx: ActorContext) -> dict:
    """Permission codes with their grant scopes, for UI navigation (never trusted server-side)."""
    if ctx.user is None:
        return {"codes": [], "grants": {}, "conditional": []}
    store = get_store()
    snapshot = get_snapshot(ctx.user.pk)
    codes, grants = [], {}
    for code, code_grants in sorted(snapshot.grants.items()):
        if code not in store.permissions:
            continue
        module = code.split(".", 1)[0]
        if module not in settings.ERP["ALWAYS_ON_MODULES"] and not flags.is_enabled(
            flags.module_flag_key(module),
            user_id=ctx.user.pk,
            role_codes=snapshot.role_codes,
            company_id=ctx.company_id,
            organization_id=ctx.user.organization_id,
        ):
            continue
        codes.append(code)
        grants[code] = sorted(
            ({"scope_type": g.scope_type, "scope_id": str(g.scope_id), "role": g.role_code} for g in code_grants),
            key=lambda item: (item["scope_type"], item["scope_id"]),
        )
    org_id = getattr(ctx.user, "organization_id", None)
    conditional = sorted({action for p in store.allow_policies if p.organization_id == org_id for action in p.actions})
    return {"codes": codes, "grants": grants, "conditional": conditional}


def accessible_company_ids(user_id: UUID) -> frozenset:
    return get_snapshot(user_id).companies


def explain(ctx: ActorContext, action: str, resource: Resource | None = None) -> dict:
    decision = authorize(ctx, action, resource)
    return {
        "allowed": decision.allowed,
        "reason": decision.reason,
        "policy": decision.policy,
        "obligations": sorted(decision.obligations),
    }
