from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("core.feature_flag", ["read", "manage"], "feature flags", sensitive=["manage"]),
    *resource_permissions("core.outbox_event", ["read", "manage"], "domain event outbox"),
]
