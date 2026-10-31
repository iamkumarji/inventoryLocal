from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("assets.asset_category", ["create", "read", "update"], "asset categories"),
    # `approve` capitalizes (posts the capitalization journal) within the approver's approval limit;
    # larger amounts are submitted (`update`) through the approvals workflow.
    *resource_permissions(
        "assets.asset",
        ["create", "read", "update", "approve", "reject", "dispose"],
        "fixed assets",
        sensitive=["approve", "reject", "dispose"],
    ),
    *resource_permissions(
        "assets.depreciation_run", ["create", "read", "post", "cancel"], "depreciation runs", mfa=["post", "cancel"]
    ),
    *resource_permissions("assets.maintenance_plan", ["create", "read", "update"], "maintenance plans"),
    *resource_permissions("assets.work_order", ["create", "read", "update", "close"], "maintenance work orders"),
    *resource_permissions("assets.meter_reading", ["create", "read"], "asset meter readings"),
]
