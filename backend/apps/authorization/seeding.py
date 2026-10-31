"""Catalogue synchronisation and template seeding (idempotent)."""

from __future__ import annotations

import fnmatch

from django.db import transaction

from . import registry
from .models import AbacPolicy, Permission, Role, RolePermission, SodRule
from .templates import POLICY_TEMPLATES, ROLE_TEMPLATES, SOD_TEMPLATES


@transaction.atomic
def sync_permissions() -> dict:
    specs = registry.collect()
    created = updated = 0
    for code, spec in specs.items():
        defaults = {
            "module": spec.module,
            "resource": spec.resource,
            "action": spec.action,
            "description": spec.description,
            "is_sensitive": spec.is_sensitive,
            "requires_mfa": spec.requires_mfa,
            "is_active": True,
        }
        obj, was_created = Permission.objects.get_or_create(code=code, defaults=defaults)
        if was_created:
            created += 1
        elif any(getattr(obj, k) != v for k, v in defaults.items()):
            for key, value in defaults.items():
                setattr(obj, key, value)
            obj.save()
            updated += 1
    # Retired permissions are deactivated, never deleted (history and role links stay intact).
    deactivated = Permission.objects.filter(is_active=True).exclude(code__in=specs).update(is_active=False)
    return {"created": created, "updated": updated, "deactivated": deactivated, "total": len(specs)}


def resolve_patterns(patterns: list[str], codes: list[str]) -> set[str]:
    selected: set[str] = set()
    for pattern in patterns:
        if not pattern.startswith("!"):
            selected |= {c for c in codes if fnmatch.fnmatchcase(c, pattern)}
    for pattern in patterns:
        if pattern.startswith("!"):
            selected -= {c for c in codes if fnmatch.fnmatchcase(c, pattern[1:])}
    return selected


@transaction.atomic
def seed_templates(organization) -> dict:
    active = dict(Permission.objects.filter(is_active=True).values_list("code", "id"))
    codes = sorted(active)
    roles = 0
    for tpl in ROLE_TEMPLATES:
        role, _ = Role.objects.update_or_create(
            organization=organization,
            code=tpl["code"],
            defaults={
                "name": f"{tpl['name']} (template)",
                "description": tpl.get("description", ""),
                "is_system_template": True,
                "mfa_required": tpl.get("mfa_required", False),
                "max_session_minutes": tpl.get("max_session_minutes"),
            },
        )
        wanted = resolve_patterns(tpl["permissions"], codes)
        current = set(role.role_permissions.values_list("permission__code", flat=True))
        RolePermission.objects.filter(role=role, permission__code__in=current - wanted).delete()
        RolePermission.objects.bulk_create(
            [RolePermission(role=role, permission_id=active[c]) for c in wanted - current]
        )
        roles += 1

    policies = 0
    for tpl in POLICY_TEMPLATES:
        _, created = AbacPolicy.objects.get_or_create(
            organization=organization,
            code=tpl["code"],
            defaults={**{k: v for k, v in tpl.items() if k != "code"}, "is_template": True},
        )
        policies += int(created)

    sod_created, sod_skipped = 0, []
    perms = {p.code: p for p in Permission.objects.filter(is_active=True)}
    for code, a, b, mode, description in SOD_TEMPLATES:
        if a not in perms or b not in perms:
            sod_skipped.append(code)
            continue
        _, created = SodRule.objects.get_or_create(
            organization=organization,
            code=code,
            defaults={"permission_a": perms[a], "permission_b": perms[b], "mode": mode, "description": description},
        )
        sod_created += int(created)
    return {
        "role_templates": roles,
        "policies_created": policies,
        "sod_created": sod_created,
        "sod_skipped_missing_permissions": sod_skipped,
    }
