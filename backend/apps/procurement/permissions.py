from apps.authorization.registry import resource_permissions

PERMISSIONS = [
    *resource_permissions(
        "procurement.purchase_requisition",
        ["create", "read", "update", "approve", "reject", "cancel"],
        "purchase requisitions",
    ),
    *resource_permissions("procurement.rfq", ["create", "read", "update", "approve"], "RFQs and quotations"),
    *resource_permissions(
        "procurement.purchase_order",
        ["create", "read", "update", "approve", "reject", "cancel", "export", "self_approve"],
        "purchase orders",
        sensitive=["export"],
        mfa=["self_approve"],
    ),
    *resource_permissions("procurement.goods_receipt", ["create", "read", "post"], "goods receipts"),
    *resource_permissions("procurement.purchase_return", ["create", "read", "post"], "purchase returns"),
    *resource_permissions("procurement.mrp", ["create", "read"], "material requirements planning"),
]
