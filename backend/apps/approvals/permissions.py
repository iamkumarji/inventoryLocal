from apps.authorization.registry import resource_permissions

from . import demo

PERMISSIONS = [
    *resource_permissions("approvals.approval_matrix", ["read", "manage"], "approval matrices", mfa=["manage"]),
    *resource_permissions(
        "approvals.approval_request", ["read", "export"], "approval requests (oversight)", sensitive=["export"]
    ),
]


def permissions():
    """Evaluated at each sync: development-only demo permissions depend on settings."""
    return [*PERMISSIONS, *demo.permissions()]
