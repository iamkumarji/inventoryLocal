"""Cached authorization data.

* PolicyStore: permission catalogue, ABAC policies, approval limits, SoD rules
  and the org tree. Shared by all users; rebuilt when the authz version changes.
* SubjectSnapshot: one user's effective grants (permission -> scoped grants).

Any change to roles, assignments, policies, limits, SoD rules or the org
structure bumps the global version (signals.py), invalidating both.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from .scopes import OrgTree, ScopeSet

VERSION_KEY = "authz:version"
_local: dict = {}


def current_version() -> int:
    version = cache.get(VERSION_KEY)
    if version is None:
        cache.add(VERSION_KEY, 1, None)
        version = cache.get(VERSION_KEY) or 1
    return int(version)


def bump_version() -> None:
    try:
        cache.incr(VERSION_KEY)
    except ValueError:
        cache.set(VERSION_KEY, 2, None)
    _local.clear()


@dataclass(frozen=True)
class PermissionInfo:
    code: str
    is_sensitive: bool
    requires_mfa: bool


@dataclass(frozen=True)
class PolicyInfo:
    id: UUID
    organization_id: UUID
    code: str
    effect: str
    priority: int
    actions: tuple
    resource_types: tuple
    condition: dict

    def targets(self, action: str, resource_type: str | None) -> bool:
        if self.resource_types and resource_type is not None and resource_type not in self.resource_types:
            return False
        return any(_pattern_match(pattern, action) for pattern in self.actions)


def _pattern_match(pattern: str, code: str) -> bool:
    p_parts, c_parts = pattern.split("."), code.split(".")
    if len(p_parts) != 3:
        return False
    return all(p == "*" or p == c for p, c in zip(p_parts, c_parts, strict=True))


@dataclass
class PolicyStore:
    version: int
    permissions: dict[str, PermissionInfo]
    allow_policies: list[PolicyInfo]
    deny_policies: list[PolicyInfo]
    # (role_id, document_type, currency) -> [(company_id | None, max_amount)]
    approval_limits: dict[tuple, list[tuple[UUID | None, Decimal]]]
    # permission code -> [(rule code, conflicting permission code)]
    sod_same_record: dict[str, list[tuple[str, str]]]
    sod_same_user: list[tuple[str, str, str]]
    tree: OrgTree


def _build_store(version: int) -> PolicyStore:
    from .models import AbacPolicy, ApprovalLimit, Permission, SodRule

    permissions = {
        code: PermissionInfo(code, sensitive, mfa)
        for code, sensitive, mfa in Permission.objects.filter(is_active=True).values_list(
            "code", "is_sensitive", "requires_mfa"
        )
    }
    allow, deny = [], []
    for p in AbacPolicy.objects.filter(is_active=True).order_by("priority", "code"):
        info = PolicyInfo(
            p.id,
            p.organization_id,
            p.code,
            p.effect,
            p.priority,
            tuple(p.actions),
            tuple(p.resource_types),
            p.condition or {},
        )
        (allow if p.effect == AbacPolicy.Effect.ALLOW else deny).append(info)
    limits: dict[tuple, list] = defaultdict(list)
    for role_id, doc_type, currency, company_id, amount in ApprovalLimit.objects.filter(is_active=True).values_list(
        "role_id", "document_type", "currency", "company_id", "max_amount"
    ):
        limits[(role_id, doc_type, currency)].append((company_id, amount))
    same_record: dict[str, list] = defaultdict(list)
    same_user = []
    for rule in SodRule.objects.filter(is_active=True).select_related("permission_a", "permission_b"):
        a, b = rule.permission_a.code, rule.permission_b.code
        if rule.mode == SodRule.Mode.SAME_USER_SAME_RECORD:
            same_record[a].append((rule.code, b))
            same_record[b].append((rule.code, a))
        else:
            same_user.append((rule.code, a, b))
    return PolicyStore(version, permissions, allow, deny, dict(limits), dict(same_record), same_user, OrgTree.load())


def get_store() -> PolicyStore:
    version = current_version()
    cached = _local.get("store")
    if cached is not None and cached.version == version:
        return cached
    store = _build_store(version)
    _local["store"] = store
    return store


@dataclass(frozen=True)
class Grant:
    assignment_id: UUID
    role_id: UUID
    role_code: str
    scope_type: str
    scope_id: UUID
    scope: ScopeSet


@dataclass
class SubjectSnapshot:
    user_id: UUID
    version: int
    expires_at: datetime | None
    grants: dict[str, tuple[Grant, ...]] = field(default_factory=dict)
    role_codes: frozenset = frozenset()
    companies: frozenset = frozenset()
    mfa_required: bool = False
    max_session_minutes: int | None = None

    def is_fresh(self, version: int) -> bool:
        return self.version == version and (self.expires_at is None or timezone.now() < self.expires_at)


def _build_snapshot(user_id: UUID, store: PolicyStore) -> SubjectSnapshot:
    from .models import RoleAssignment, RolePermission

    now = timezone.now()
    expires_at: datetime | None = None
    active = []
    for a in RoleAssignment.objects.filter(
        user_id=user_id, revoked_at__isnull=True, role__is_active=True
    ).select_related("role"):
        if a.valid_from and a.valid_from > now:
            expires_at = a.valid_from if expires_at is None else min(expires_at, a.valid_from)
            continue
        if a.valid_until and a.valid_until <= now:
            continue
        if a.valid_until:
            expires_at = a.valid_until if expires_at is None else min(expires_at, a.valid_until)
        active.append(a)

    perms_by_role: dict[UUID, set[str]] = defaultdict(set)
    for role_id, code in RolePermission.objects.filter(
        role_id__in={a.role_id for a in active}, permission__is_active=True
    ).values_list("role_id", "permission__code"):
        perms_by_role[role_id].add(code)

    grants: dict[str, list[Grant]] = defaultdict(list)
    companies: set = set()
    session_limits = []
    for a in active:
        scope = store.tree.expand(a.scope_type, a.scope_id, a.include_descendants)
        if scope.is_empty():
            continue
        companies |= store.tree.companies_for(a.scope_type, a.scope_id)
        grant = Grant(a.id, a.role_id, a.role.code, a.scope_type, a.scope_id, scope)
        for code in perms_by_role.get(a.role_id, ()):
            grants[code].append(grant)
        if a.role.max_session_minutes:
            session_limits.append(a.role.max_session_minutes)

    return SubjectSnapshot(
        user_id=user_id,
        version=store.version,
        expires_at=expires_at,
        grants={code: tuple(g) for code, g in grants.items()},
        role_codes=frozenset(a.role.code for a in active),
        companies=frozenset(companies),
        mfa_required=any(a.role.mfa_required for a in active),
        max_session_minutes=min(session_limits) if session_limits else None,
    )


def get_snapshot(user_id: UUID) -> SubjectSnapshot:
    store = get_store()
    key = f"authz:snap:{user_id}"
    snapshot = cache.get(key)
    if snapshot is None or not snapshot.is_fresh(store.version):
        snapshot = _build_snapshot(user_id, store)
        cache.set(key, snapshot, settings.ERP["AUTHZ_CACHE_SECONDS"])
    return snapshot
