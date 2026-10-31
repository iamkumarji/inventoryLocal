from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("manufacturing.work_center", ["create", "read", "update"], "work centres"),
    *resource_permissions(
        "manufacturing.bom", ["create", "read", "update", "approve"], "bills of materials", sensitive=["approve"]
    ),
    *resource_permissions(
        "manufacturing.production_order",
        ["create", "read", "release", "issue", "confirm", "receive", "close", "cancel"],
        "production orders",
    ),
    *resource_permissions("manufacturing.production_plan", ["create", "read", "update"], "production plans"),
]
