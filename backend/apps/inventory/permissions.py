from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("inventory.location", ["create", "read", "update"], "storage locations"),
    *resource_permissions("inventory.batch", ["read"], "batches and serial numbers"),
    *resource_permissions(
        "inventory.stock_balance", ["read", "export"], "stock on hand and valuation", sensitive=["export"]
    ),
    *resource_permissions("inventory.stock_ledger", ["read", "export"], "stock ledger", sensitive=["export"]),
    *resource_permissions(
        "inventory.stock", ["negative_override"], "negative stock override", mfa=["negative_override"]
    ),
    *resource_permissions("inventory.reservation", ["create", "read", "delete"], "stock reservations"),
    *resource_permissions(
        "inventory.stock_adjustment",
        ["create", "read", "update", "approve", "reject", "post", "self_approve"],
        "stock adjustments",
        mfa=["self_approve"],
    ),
    *resource_permissions(
        "inventory.stock_transfer", ["create", "read", "update", "dispatch", "receive"], "stock transfers"
    ),
    *resource_permissions("inventory.stock_count", ["create", "read", "update", "approve"], "stock counts"),
]
