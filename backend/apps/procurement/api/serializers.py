from rest_framework import serializers

from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.masterdata.models import Item, Uom
from apps.organization.models import Branch, Company, Department, Warehouse
from apps.partners.models import Partner
from apps.procurement.models import (
    GoodsReceipt,
    GoodsReceiptLine,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseRequisition,
    PurchaseReturn,
    PurchaseReturnLine,
    QuotationLine,
    RequestForQuotation,
    RequisitionLine,
    RFQLine,
    SupplierQuotation,
)

DOC = [
    "id",
    "number",
    "status",
    "version",
    "amount",
    "currency",
    "submitted_by",
    "approved_by",
    "created_by",
    "created_at",
]


class OrgPK(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get("request")
        qs = super().get_queryset()
        return qs.none() if request is None else qs.filter(organization_id=request.user.organization_id)


def company_field(action):
    return ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action=action)


class PurchasePRLineSerializer(serializers.ModelSerializer):
    item = OrgPK(queryset=Item.objects.filter(is_active=True))
    uom = OrgPK(queryset=Uom.objects.all())
    warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.filter(is_active=True))
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = RequisitionLine
        fields = ["id", "item", "item_code", "quantity", "uom", "estimated_rate", "warehouse", "ordered_quantity"]
        read_only_fields = ["id", "item_code", "ordered_quantity"]


class PurchaseRequisitionSerializer(serializers.ModelSerializer):
    company = company_field("procurement.purchase_requisition.read")
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.all())
    department = serializers.PrimaryKeyRelatedField(queryset=Department.objects.all(), required=False, allow_null=True)
    lines = PurchasePRLineSerializer(many=True)

    class Meta:
        model = PurchaseRequisition
        fields = [*DOC, "company", "branch", "department", "needed_by", "purpose", "lines"]
        read_only_fields = DOC


class PurchaseRFQLineSerializer(serializers.ModelSerializer):
    item = OrgPK(queryset=Item.objects.all())
    uom = OrgPK(queryset=Uom.objects.all())

    class Meta:
        model = RFQLine
        fields = ["id", "item", "quantity", "uom", "requisition_line"]
        read_only_fields = ["id", "requisition_line"]


class PurchaseRFQSerializer(serializers.ModelSerializer):
    company = company_field("procurement.rfq.read")
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.all())
    suppliers = OrgPK(queryset=Partner.objects.filter(is_supplier=True), many=True)
    lines = PurchaseRFQLineSerializer(many=True, required=False)

    class Meta:
        model = RequestForQuotation
        fields = [
            "id",
            "number",
            "status",
            "version",
            "company",
            "branch",
            "requisition",
            "respond_by",
            "suppliers",
            "notes",
            "lines",
            "created_at",
        ]
        read_only_fields = ["id", "number", "status", "version", "created_at"]


class PurchaseQuoteLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = QuotationLine
        fields = ["id", "rfq_line", "rate", "discount_pct"]
        read_only_fields = ["id"]


class PurchaseQuotationSerializer(serializers.ModelSerializer):
    supplier = OrgPK(queryset=Partner.objects.filter(is_supplier=True))
    lines = PurchaseQuoteLineSerializer(many=True)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)

    class Meta:
        model = SupplierQuotation
        fields = [
            "id",
            "rfq",
            "supplier",
            "supplier_name",
            "supplier_reference",
            "received_on",
            "valid_until",
            "lead_time_days",
            "payment_terms_days",
            "status",
            "selection_reason",
            "total",
            "lines",
        ]
        read_only_fields = ["id", "rfq", "status", "selection_reason", "total"]


class PurchaseSelectQuotationSerializer(serializers.Serializer):
    quotation = serializers.PrimaryKeyRelatedField(queryset=SupplierQuotation.objects.all())
    reason = serializers.CharField(required=False, allow_blank=True, default="")
    warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.filter(is_active=True))
    expected_date = serializers.DateField()


class PurchasePOLineSerializer(serializers.ModelSerializer):
    item = OrgPK(queryset=Item.objects.filter(is_active=True))
    uom = OrgPK(queryset=Uom.objects.all())
    warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.filter(is_active=True))
    item_code = serializers.CharField(source="item.code", read_only=True)
    item_name = serializers.CharField(source="item.name", read_only=True)

    class Meta:
        model = PurchaseOrderLine
        fields = [
            "id",
            "line_no",
            "item",
            "item_code",
            "item_name",
            "description",
            "quantity",
            "uom",
            "rate",
            "discount_pct",
            "gst_rate",
            "taxable_amount",
            "cgst",
            "sgst",
            "igst",
            "warehouse",
            "over_receipt_pct",
            "received_quantity",
            "invoiced_quantity",
            "returned_quantity",
        ]
        read_only_fields = [
            "id",
            "line_no",
            "item_code",
            "item_name",
            "gst_rate",
            "taxable_amount",
            "cgst",
            "sgst",
            "igst",
            "received_quantity",
            "invoiced_quantity",
            "returned_quantity",
        ]


class PurchaseOrderSerializer(serializers.ModelSerializer):
    company = company_field("procurement.purchase_order.read")
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.all())
    supplier = OrgPK(queryset=Partner.objects.filter(is_supplier=True))
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    lines = PurchasePOLineSerializer(many=True)

    class Meta:
        model = PurchaseOrder
        fields = [
            *DOC,
            "company",
            "branch",
            "supplier",
            "supplier_name",
            "order_date",
            "expected_date",
            "payment_terms_days",
            "revision",
            "quotation",
            "requisition",
            "intra_state",
            "subtotal",
            "tax_total",
            "receipt_status",
            "notes",
            "lines",
        ]
        read_only_fields = [
            *DOC,
            "revision",
            "quotation",
            "requisition",
            "intra_state",
            "subtotal",
            "tax_total",
            "receipt_status",
        ]


class PurchaseGRNLineSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source="po_line.item.code", read_only=True)

    class Meta:
        model = GoodsReceiptLine
        fields = [
            "id",
            "po_line",
            "item_code",
            "quantity",
            "stock_quantity",
            "unit_cost",
            "batch_number",
            "manufactured_on",
            "expires_on",
            "serials",
            "location",
            "inspection",
            "invoiced_quantity",
        ]
        read_only_fields = ["id", "item_code", "stock_quantity", "unit_cost", "inspection", "invoiced_quantity"]


class PurchaseReceiptSerializer(serializers.ModelSerializer):
    purchase_order = serializers.PrimaryKeyRelatedField(queryset=PurchaseOrder.objects.all())
    warehouse = ScopedPrimaryKeyRelatedField(
        queryset=Warehouse.objects.all(), read_action="procurement.goods_receipt.read"
    )
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    lines = PurchaseGRNLineSerializer(many=True)

    class Meta:
        model = GoodsReceipt
        fields = [
            "id",
            "number",
            "status",
            "version",
            "purchase_order",
            "supplier",
            "supplier_name",
            "warehouse",
            "receipt_date",
            "supplier_delivery_note",
            "vehicle_number",
            "stock_transaction",
            "posted_by",
            "created_at",
            "lines",
        ]
        read_only_fields = [
            "id",
            "number",
            "status",
            "version",
            "supplier",
            "stock_transaction",
            "posted_by",
            "created_at",
        ]


class PurchaseReturnLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = PurchaseReturnLine
        fields = ["id", "receipt_line", "quantity", "from_status"]
        read_only_fields = ["id"]


class PurchaseReturnSerializer(serializers.ModelSerializer):
    receipt = serializers.PrimaryKeyRelatedField(queryset=GoodsReceipt.objects.filter(status="posted"))
    lines = PurchaseReturnLineSerializer(many=True)

    class Meta:
        model = PurchaseReturn
        fields = [
            "id",
            "number",
            "status",
            "version",
            "receipt",
            "supplier",
            "warehouse",
            "return_date",
            "reason",
            "stock_transaction",
            "lines",
        ]
        read_only_fields = ["id", "number", "status", "version", "supplier", "warehouse", "stock_transaction"]
