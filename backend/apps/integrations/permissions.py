from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions(
        "integrations.webhook",
        ["create", "read", "update", "delete", "manage"],
        "outbound webhooks",
        sensitive=["create", "update", "delete", "manage"],
        mfa=["create", "manage"],
    ),
]
