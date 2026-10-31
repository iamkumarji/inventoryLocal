from django.conf import settings
from django.db import models
from django.db.models import F, Q

from apps.core.fields import MoneyField, PercentField, QuantityField, RateField
from apps.core.models import CompanyScopedModel, UUIDModel, VersionedModel


class _Priced(UUIDModel):
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField()
    uom = models.ForeignKey("masterdata.Uom", on_delete=models.PROTECT, related_name="+")
    rate = RateField()
    discount_pct = PercentField(default=0)
    gst_rate = PercentField(default=0)
    taxable_amount = MoneyField(default=0)
    cgst = MoneyField(default=0)
    sgst = MoneyField(default=0)
    igst = MoneyField(default=0)

    class Meta:
        abstract = True


class SalesQuotation(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    customer = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    quote_date = models.DateField()
    valid_until = models.DateField()
    status = models.CharField(max_length=10, default="open")  # open | accepted | lost | expired
    intra_state = models.BooleanField(default=True)
    amount = MoneyField(default=0)
    notes = models.TextField(blank=True)

    authz_resource_type = "sales.quotation"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id"}

    class Meta:
        db_table = "sales_quotations"


class SalesQuotationLine(_Priced):
    quotation = models.ForeignKey(SalesQuotation, on_delete=models.CASCADE, related_name="lines")

    class Meta:
        db_table = "sales_quotation_lines"


class SalesOrder(CompanyScopedModel, VersionedModel):
    class Credit(models.TextChoices):
        PENDING = "pending"
        OK = "ok"
        BLOCKED = "blocked"
        OVERRIDDEN = "overridden"

    number = models.CharField(max_length=40, blank=True)
    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    customer = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    quotation = models.ForeignKey(SalesQuotation, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    customer_po = models.CharField(max_length=60, blank=True)
    order_date = models.DateField()
    requested_date = models.DateField()
    place_of_supply = models.CharField(max_length=2)
    intra_state = models.BooleanField(default=True)
    status = models.CharField(max_length=12, default="draft")  # draft|submitted|approved|rejected|cancelled|closed
    credit_status = models.CharField(max_length=12, choices=Credit.choices, default=Credit.PENDING)
    credit_note = models.CharField(max_length=300, blank=True)
    subtotal = MoneyField(default=0)
    tax_total = MoneyField(default=0)
    amount = MoneyField(default=0)
    currency = models.CharField(max_length=3, default="INR")
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "sales.sales_order"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id"}

    class Meta:
        db_table = "sales_orders"
        indexes = [
            models.Index(fields=["company", "status"], name="ix_so_status"),
            models.Index(fields=["customer"], name="ix_so_customer"),
        ]


class SalesOrderLine(_Priced):
    order = models.ForeignKey(SalesOrder, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    stock_quantity = QuantityField(default=0)  # in stock UoM
    reserved_quantity = QuantityField(default=0)  # stock UoM
    delivered_quantity = QuantityField(default=0)  # stock UoM
    invoiced_quantity = QuantityField(default=0)  # stock UoM
    returned_quantity = QuantityField(default=0)
    reservation = models.ForeignKey(
        "inventory.StockReservation", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        db_table = "sales_order_lines"
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0, rate__gte=0), name="ck_so_line_values"),
            models.CheckConstraint(
                condition=Q(delivered_quantity__lte=F("stock_quantity")), name="ck_so_over_delivery"
            ),
            models.CheckConstraint(
                condition=Q(invoiced_quantity__lte=F("delivered_quantity")), name="ck_so_invoice_after_delivery"
            ),
        ]


class Delivery(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    sales_order = models.ForeignKey(SalesOrder, on_delete=models.PROTECT, related_name="deliveries")
    customer = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    delivery_date = models.DateField()
    status = models.CharField(max_length=10, default="draft")  # draft | posted
    stock_transaction = models.ForeignKey(
        "inventory.StockTransaction", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    eway_bill_number = models.CharField(max_length=20, blank=True)

    authz_resource_type = "sales.delivery"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "deliveries"


class DeliveryLine(UUIDModel):
    delivery = models.ForeignKey(Delivery, on_delete=models.CASCADE, related_name="lines")
    so_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, related_name="delivery_lines")
    quantity = QuantityField()  # stock UoM
    batch = models.ForeignKey("inventory.Batch", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    serials = models.JSONField(default=list, blank=True)
    location = models.ForeignKey(
        "inventory.Location", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    cost_value = MoneyField(default=0)  # COGS recorded on posting (used for returns)

    class Meta:
        db_table = "delivery_lines"
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_delivery_line_qty")]


class SalesInvoice(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    sales_order = models.ForeignKey(SalesOrder, on_delete=models.PROTECT, related_name="invoices")
    customer = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    invoice_date = models.DateField()
    due_date = models.DateField()
    place_of_supply = models.CharField(max_length=2)
    intra_state = models.BooleanField(default=True)
    customer_gstin = models.CharField(max_length=15, blank=True)
    status = models.CharField(max_length=10, default="draft")  # draft | posted | cancelled
    subtotal = MoneyField(default=0)
    cgst = MoneyField(default=0)
    sgst = MoneyField(default=0)
    igst = MoneyField(default=0)
    total = MoneyField(default=0)
    irn = models.CharField(max_length=64, blank=True)  # e-invoice reference (D-10: via GSP integration)
    journal_entry = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "sales.invoice"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id"}

    class Meta:
        db_table = "sales_invoices"


class SalesInvoiceLine(UUIDModel):
    invoice = models.ForeignKey(SalesInvoice, on_delete=models.CASCADE, related_name="lines")
    so_line = models.ForeignKey(SalesOrderLine, on_delete=models.PROTECT, related_name="invoice_lines")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    hsn_code = models.CharField(max_length=8, blank=True)
    quantity = QuantityField()  # stock UoM
    rate = RateField()  # per stock UoM, after discount
    gst_rate = PercentField(default=0)
    taxable_amount = MoneyField(default=0)
    cgst = MoneyField(default=0)
    sgst = MoneyField(default=0)
    igst = MoneyField(default=0)
    returned_quantity = QuantityField(default=0)

    class Meta:
        db_table = "sales_invoice_lines"


class SalesReturn(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    invoice = models.ForeignKey(SalesInvoice, on_delete=models.PROTECT, related_name="returns")
    customer = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    return_date = models.DateField()
    reason = models.CharField(max_length=300)
    status = models.CharField(max_length=10, default="draft")
    credit_total = MoneyField(default=0)
    stock_transaction = models.ForeignKey(
        "inventory.StockTransaction", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    journal_entry = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "sales.sales_return"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "sales_returns"


class SalesReturnLine(UUIDModel):
    sales_return = models.ForeignKey(SalesReturn, on_delete=models.CASCADE, related_name="lines")
    invoice_line = models.ForeignKey(SalesInvoiceLine, on_delete=models.PROTECT, related_name="return_lines")
    quantity = QuantityField()
    restock = models.BooleanField(default=True)  # good condition -> unrestricted; else blocked
    batch = models.ForeignKey("inventory.Batch", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    serials = models.JSONField(default=list, blank=True)

    class Meta:
        db_table = "sales_return_lines"
