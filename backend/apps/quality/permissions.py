from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("quality.inspection_plan", ["create", "read", "update"], "inspection plans"),
    *resource_permissions("quality.inspection", ["read", "approve"], "quality inspections"),
    *resource_permissions("quality.ncr", ["read", "update"], "non-conformance reports"),
]
