from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("audit.audit_event", ["read", "export", "manage"], "audit events", sensitive=["export"]),
]
