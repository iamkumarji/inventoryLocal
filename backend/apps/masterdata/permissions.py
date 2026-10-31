from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("masterdata.uom", ["create", "read", "update"], "units of measure"),
    *resource_permissions("masterdata.item_category", ["create", "read", "update"], "item categories"),
    *resource_permissions(
        "masterdata.hsn_code", ["create", "read", "update"], "HSN/SAC codes and GST rates", sensitive=["update"]
    ),
    *resource_permissions("masterdata.item", ["create", "read", "update", "export"], "items", sensitive=["export"]),
    *resource_permissions("masterdata.item_policy", ["create", "read", "update"], "item planning parameters"),
]
