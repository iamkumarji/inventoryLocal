from django.conf import settings
from django.db import models
from django.db.models import F, Q

from apps.core.fields import MoneyField, PercentField, QuantityField, RateField
from apps.core.models import CompanyScopedModel, UUIDModel, VersionedModel

STATUSES = ["draft", "submitted", "approved", "rejected", "cancelled", "closed"]


class ApprovableDoc(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    status = models.CharField(max_length=20, default="draft")
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    amount = MoneyField(default=0)
    currency = models.CharField(max_length=3, default="INR")

    class Meta:
        abstract = True


class PurchaseRequisition(ApprovableDoc):
    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    department = models.ForeignKey(
        "organization.Department", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    needed_by = models.DateField()
    purpose = models.CharField(max_length=300)

    authz_resource_type = "procurement.purchase_requisition"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id", "department": "department_id"}

    class Meta:
        db_table = "purchase_requisitions"


class RequisitionLine(UUIDModel):
    requisition = models.ForeignKey(PurchaseRequisition, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField()
    uom = models.ForeignKey("masterdata.Uom", on_delete=models.PROTECT, related_name="+")
    estimated_rate = RateField(default=0)
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    ordered_quantity = QuantityField(default=0)

    class Meta:
        db_table = "purchase_requisition_lines"
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_pr_line_qty")]


class RequestForQuotation(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    requisition = models.ForeignKey(
        PurchaseRequisition, null=True, blank=True, on_delete=models.PROTECT, related_name="rfqs"
    )
    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    respond_by = models.DateField()
    status = models.CharField(max_length=10, default="open")  # open | closed | cancelled
    suppliers = models.ManyToManyField("partners.Partner", related_name="+")
    notes = models.TextField(blank=True)

    authz_resource_type = "procurement.rfq"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id"}

    class Meta:
        db_table = "rfqs"


class RFQLine(UUIDModel):
    rfq = models.ForeignKey(RequestForQuotation, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField()
    uom = models.ForeignKey("masterdata.Uom", on_delete=models.PROTECT, related_name="+")
    requisition_line = models.ForeignKey(
        RequisitionLine, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        db_table = "rfq_lines"


class SupplierQuotation(CompanyScopedModel, VersionedModel):
    rfq = models.ForeignKey(RequestForQuotation, on_delete=models.PROTECT, related_name="quotations")
    supplier = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    supplier_reference = models.CharField(max_length=60, blank=True)
    received_on = models.DateField()
    valid_until = models.DateField()
    lead_time_days = models.PositiveIntegerField()
    payment_terms_days = models.PositiveIntegerField(default=30)
    status = models.CharField(max_length=15, default="received")  # received | selected | not_selected
    selection_reason = models.TextField(blank=True)
    total = MoneyField(default=0)

    authz_resource_type = "procurement.rfq"

    class Meta:
        db_table = "supplier_quotations"
        constraints = [models.UniqueConstraint(fields=["rfq", "supplier"], name="uq_quotation_per_supplier")]


class QuotationLine(UUIDModel):
    quotation = models.ForeignKey(SupplierQuotation, on_delete=models.CASCADE, related_name="lines")
    rfq_line = models.ForeignKey(RFQLine, on_delete=models.PROTECT, related_name="quoted")
    rate = RateField()
    discount_pct = PercentField(default=0)

    class Meta:
        db_table = "supplier_quotation_lines"
        constraints = [models.CheckConstraint(condition=Q(rate__gte=0), name="ck_quote_rate")]


class PurchaseOrder(ApprovableDoc):
    supplier = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    order_date = models.DateField()
    expected_date = models.DateField()
    payment_terms_days = models.PositiveIntegerField(default=30)
    revision = models.PositiveSmallIntegerField(default=0)
    quotation = models.ForeignKey(SupplierQuotation, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    requisition = models.ForeignKey(
        PurchaseRequisition, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    intra_state = models.BooleanField(default=True)
    subtotal = MoneyField(default=0)
    tax_total = MoneyField(default=0)
    notes = models.TextField(blank=True)
    # receipt progress: open | partially_received | received
    receipt_status = models.CharField(max_length=20, default="open")

    authz_resource_type = "procurement.purchase_order"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id"}

    class Meta:
        db_table = "purchase_orders"
        indexes = [
            models.Index(fields=["company", "status"], name="ix_po_status"),
            models.Index(fields=["supplier"], name="ix_po_supplier"),
        ]


class PurchaseOrderLine(UUIDModel):
    order = models.ForeignKey(PurchaseOrder, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    description = models.CharField(max_length=300, blank=True)
    quantity = QuantityField()
    uom = models.ForeignKey("masterdata.Uom", on_delete=models.PROTECT, related_name="+")
    rate = RateField()
    discount_pct = PercentField(default=0)
    gst_rate = PercentField(default=0)
    taxable_amount = MoneyField(default=0)
    cgst = MoneyField(default=0)
    sgst = MoneyField(default=0)
    igst = MoneyField(default=0)
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    over_receipt_pct = PercentField(default=0)
    received_quantity = QuantityField(default=0)  # in order UoM
    invoiced_quantity = QuantityField(default=0)
    returned_quantity = QuantityField(default=0)
    requisition_line = models.ForeignKey(
        RequisitionLine, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        db_table = "purchase_order_lines"
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0, rate__gte=0), name="ck_po_line_values"),
            models.CheckConstraint(
                condition=Q(received_quantity__lte=F("quantity") * (1 + F("over_receipt_pct") / 100)),
                name="ck_po_line_over_receipt",
            ),
            models.CheckConstraint(
                condition=Q(returned_quantity__lte=F("received_quantity")), name="ck_po_line_returns"
            ),
        ]


class GoodsReceipt(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    purchase_order = models.ForeignKey(PurchaseOrder, on_delete=models.PROTECT, related_name="receipts")
    supplier = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    receipt_date = models.DateField()
    supplier_delivery_note = models.CharField(max_length=60, blank=True)
    vehicle_number = models.CharField(max_length=20, blank=True)
    status = models.CharField(max_length=10, default="draft")  # draft | posted
    stock_transaction = models.ForeignKey(
        "inventory.StockTransaction", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    posted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "procurement.goods_receipt"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "goods_receipts"


class GoodsReceiptLine(UUIDModel):
    receipt = models.ForeignKey(GoodsReceipt, on_delete=models.CASCADE, related_name="lines")
    po_line = models.ForeignKey(PurchaseOrderLine, on_delete=models.PROTECT, related_name="receipt_lines")
    quantity = QuantityField()  # order UoM
    stock_quantity = QuantityField(default=0)
    unit_cost = RateField(default=0)  # per stock UoM, at PO price
    batch_number = models.CharField(max_length=60, blank=True)
    manufactured_on = models.DateField(null=True, blank=True)
    expires_on = models.DateField(null=True, blank=True)
    serials = models.JSONField(default=list, blank=True)
    location = models.ForeignKey(
        "inventory.Location", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    inspection = models.ForeignKey(
        "quality.Inspection", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    invoiced_quantity = QuantityField(default=0)

    class Meta:
        db_table = "goods_receipt_lines"
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_grn_line_qty")]


class PurchaseReturn(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    receipt = models.ForeignKey(GoodsReceipt, on_delete=models.PROTECT, related_name="returns")
    supplier = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    return_date = models.DateField()
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=10, default="draft")  # draft | posted
    stock_transaction = models.ForeignKey(
        "inventory.StockTransaction", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "procurement.purchase_return"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "purchase_returns"


class PurchaseReturnLine(UUIDModel):
    purchase_return = models.ForeignKey(PurchaseReturn, on_delete=models.CASCADE, related_name="lines")
    receipt_line = models.ForeignKey(GoodsReceiptLine, on_delete=models.PROTECT, related_name="return_lines")
    quantity = QuantityField()  # order UoM
    from_status = models.CharField(max_length=15, default="blocked")  # rejected stock is usually returned

    class Meta:
        db_table = "purchase_return_lines"
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_return_line_qty")]


from .mrp import MrpRun, MrpSuggestion  # noqa: E402,F401 - MRP models live in mrp.py
