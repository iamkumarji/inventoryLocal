from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions(
        "partners.partner", ["create", "read", "update", "export"], "suppliers and customers", sensitive=["export"]
    ),
    *resource_permissions("partners.supplier", ["read", "update", "approve"], "supplier terms and approval"),
    *resource_permissions("partners.customer", ["read", "update"], "customer credit terms", sensitive=["update"]),
    *resource_permissions(
        "partners.bank_account",
        ["read", "update", "approve"],
        "partner bank accounts",
        sensitive=["read", "update"],
        mfa=["approve"],
    ),
]
