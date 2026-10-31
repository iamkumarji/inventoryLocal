"""Invalidate cached authorization data whenever its inputs change."""

from django.db import transaction
from django.db.models.signals import m2m_changed, post_delete, post_save

from apps.core import flags
from apps.core.models import FeatureFlag
from apps.organization.models import Branch, Company, Department, Facility, Organization, Warehouse

from .models import AbacPolicy, ApprovalLimit, Permission, Role, RoleAssignment, RolePermission, SodRule
from .snapshot import bump_version

WATCHED = (
    Permission,
    Role,
    RolePermission,
    RoleAssignment,
    AbacPolicy,
    SodRule,
    ApprovalLimit,
    Organization,
    Company,
    Branch,
    Facility,
    Warehouse,
    Department,
)


def _bump(**kwargs) -> None:
    # Bump now (same-process reads inside the transaction) and after commit
    # (other processes must not cache data from before the commit).
    bump_version()
    transaction.on_commit(bump_version)


def _flags_changed(**kwargs) -> None:
    flags.invalidate()
    transaction.on_commit(flags.invalidate)


for model in WATCHED:
    post_save.connect(_bump, sender=model, dispatch_uid=f"authz-save-{model.__name__}")
    post_delete.connect(_bump, sender=model, dispatch_uid=f"authz-delete-{model.__name__}")
m2m_changed.connect(_bump, sender=Role.permissions.through, dispatch_uid="authz-role-perms")
post_save.connect(_flags_changed, sender=FeatureFlag, dispatch_uid="flags-save")
post_delete.connect(_flags_changed, sender=FeatureFlag, dispatch_uid="flags-delete")
