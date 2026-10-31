from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("logistics.vehicle", ["create", "read", "update"], "vehicles"),
    *resource_permissions("logistics.driver", ["create", "read", "update"], "drivers"),
    *resource_permissions("logistics.shipment", ["create", "read", "update", "dispatch", "deliver"], "shipments"),
]
