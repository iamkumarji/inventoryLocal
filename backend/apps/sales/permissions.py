from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions("sales.quotation", ["create", "read", "update"], "sales quotations"),
    *resource_permissions(
        "sales.sales_order",
        ["create", "read", "update", "cancel", "credit_override", "export"],
        "sales orders",
        sensitive=["export"],
        mfa=["credit_override"],
    ),
    *resource_permissions("sales.delivery", ["create", "read", "post"], "deliveries"),
    *resource_permissions(
        "sales.invoice", ["create", "read", "post", "export"], "sales invoices", sensitive=["export"]
    ),
    *resource_permissions("sales.sales_return", ["create", "read", "post"], "sales returns and credit notes"),
]
