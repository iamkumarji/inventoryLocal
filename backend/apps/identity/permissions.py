from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions(
        "identity.user",
        ["create", "read", "update", "manage", "export"],
        "users",
        sensitive=["export"],
        mfa=["manage"],
    ),
    *resource_permissions("identity.auth_session", ["read", "manage"], "user sessions", sensitive=["manage"]),
]
