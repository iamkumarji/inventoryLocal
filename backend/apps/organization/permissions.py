from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("organization.organization", ["read", "update"], "organization"),
    *resource_permissions("organization.company", ["create", "read", "update", "manage"], "companies"),
    *resource_permissions("organization.branch", ["create", "read", "update"], "branches"),
    *resource_permissions("organization.department", ["create", "read", "update"], "departments"),
    *resource_permissions("organization.facility", ["create", "read", "update"], "facilities"),
    *resource_permissions("organization.warehouse", ["create", "read", "update", "manage"], "warehouses"),
    *resource_permissions(
        "organization.fiscal_year", ["create", "read", "manage"], "fiscal years and periods", sensitive=["manage"]
    ),
    *resource_permissions("organization.document_sequence", ["read", "manage"], "document number series"),
]
