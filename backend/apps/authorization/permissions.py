from .registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("authorization.permission", ["read"], "permission catalogue"),
    *resource_permissions("authorization.role", ["create", "read", "update", "manage"], "roles", sensitive=["manage"]),
    *resource_permissions("authorization.role_assignment", ["read", "assign"], "role assignments", mfa=["assign"]),
    *resource_permissions("authorization.policy", ["read", "manage"], "ABAC policies", mfa=["manage"]),
    *resource_permissions("authorization.sod_rule", ["read", "manage"], "segregation-of-duties rules", mfa=["manage"]),
    *resource_permissions("authorization.approval_limit", ["read", "manage"], "approval limits", mfa=["manage"]),
]
