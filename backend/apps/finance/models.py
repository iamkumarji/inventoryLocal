from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.fields import MoneyField
from apps.core.models import ActorStampedModel, AuthzResourceMixin, CompanyScopedModel, UUIDModel, VersionedModel


class Account(CompanyScopedModel, VersionedModel):
    class AccountType(models.TextChoices):
        ASSET = "asset"
        LIABILITY = "liability"
        EQUITY = "equity"
        INCOME = "income"
        EXPENSE = "expense"

    class SubType(models.TextChoices):
        GENERAL = "general"
        BANK = "bank"
        CASH = "cash"
        RECEIVABLE = "receivable"
        PAYABLE = "payable"
        INVENTORY = "inventory"
        TAX = "tax"
        FIXED_ASSET = "fixed_asset"
        ACCUMULATED_DEPRECIATION = "accumulated_depreciation"
        RETAINED_EARNINGS = "retained_earnings"

    code = models.CharField(max_length=20)
    name = models.CharField(max_length=150)
    account_type = models.CharField(max_length=10, choices=AccountType.choices)
    sub_type = models.CharField(max_length=30, choices=SubType.choices, default=SubType.GENERAL)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    is_group = models.BooleanField(default=False)  # headings can't receive postings
    is_control = models.BooleanField(default=False)  # AR/AP: postings must name a partner
    is_active = models.BooleanField(default=True)

    authz_resource_type = "finance.account"

    class Meta:
        db_table = "gl_accounts"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_gl_account_code"),
            models.CheckConstraint(
                condition=Q(account_type__in=["asset", "liability", "equity", "income", "expense"]),
                name="ck_gl_account_type",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} {self.name}"

    @property
    def debit_normal(self) -> bool:
        return self.account_type in (self.AccountType.ASSET, self.AccountType.EXPENSE)


class CostCenter(CompanyScopedModel, VersionedModel):
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=150)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    department = models.ForeignKey(
        "organization.Department", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    is_active = models.BooleanField(default=True)

    authz_resource_type = "finance.cost_center"

    class Meta:
        db_table = "cost_centers"
        constraints = [models.UniqueConstraint(fields=["company", "code"], name="uq_cost_center_code")]


class AccountDetermination(CompanyScopedModel):
    """Maps a posting key (+ optional item posting group / warehouse type) to a GL account.

    Resolution picks the most specific active row: group+warehouse type > warehouse type > group > default.
    """

    key = models.CharField(max_length=40)
    posting_group = models.CharField(max_length=30, blank=True)
    warehouse_type = models.CharField(max_length=20, blank=True)
    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="+")
    is_active = models.BooleanField(default=True)

    authz_resource_type = "finance.posting_rule"

    class Meta:
        db_table = "account_determinations"
        constraints = [
            models.UniqueConstraint(
                fields=["company", "key", "posting_group", "warehouse_type"],
                name="uq_account_determination",
                condition=Q(is_active=True),
            ),
        ]


class JournalEntry(AuthzResourceMixin, ActorStampedModel):
    class Status(models.TextChoices):
        DRAFT = "draft"
        POSTED = "posted"

    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    number = models.CharField(max_length=40, blank=True)
    entry_date = models.DateField()
    fiscal_period = models.ForeignKey(
        "organization.FiscalPeriod", null=True, on_delete=models.PROTECT, related_name="+"
    )
    source_module = models.CharField(max_length=30, default="finance")
    source_type = models.CharField(max_length=100, blank=True)
    source_id = models.UUIDField(null=True, blank=True)
    narration = models.CharField(max_length=500)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    posted_at = models.DateTimeField(null=True, blank=True)
    posted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    is_reversal = models.BooleanField(default=False)
    reverses = models.OneToOneField("self", null=True, blank=True, on_delete=models.PROTECT, related_name="reversal_of")
    reversed_by = models.OneToOneField("self", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    total = MoneyField(default=0)
    version = models.PositiveIntegerField(default=1)

    authz_resource_type = "finance.journal_entry"
    authz_scope_fields = {"company": "company_id"}

    class Meta:
        db_table = "journal_entries"
        constraints = [
            models.UniqueConstraint(fields=["company", "number"], name="uq_journal_number", condition=~Q(number="")),
            models.CheckConstraint(condition=Q(status__in=["draft", "posted"]), name="ck_journal_status"),
        ]
        indexes = [
            models.Index(fields=["company", "entry_date"], name="ix_journal_company_date"),
            models.Index(fields=["source_type", "source_id"], name="ix_journal_source"),
        ]


class JournalLine(UUIDModel):
    entry = models.ForeignKey(JournalEntry, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="lines")
    debit = MoneyField(default=0)
    credit = MoneyField(default=0)
    cost_center = models.ForeignKey(CostCenter, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    partner = models.ForeignKey("partners.Partner", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey("masterdata.Item", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey(
        "organization.Warehouse", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    description = models.CharField(max_length=300, blank=True)

    class Meta:
        db_table = "journal_lines"
        ordering = ["line_no"]
        constraints = [
            models.CheckConstraint(condition=Q(debit__gte=0, credit__gte=0), name="ck_journal_line_non_negative"),
            models.CheckConstraint(
                condition=(Q(debit=0) & Q(credit__gt=0)) | (Q(credit=0) & Q(debit__gt=0)),
                name="ck_journal_line_one_side",
            ),
            models.UniqueConstraint(fields=["entry", "line_no"], name="uq_journal_line_no"),
        ]
        indexes = [
            models.Index(fields=["account", "entry"], name="ix_journal_line_account"),
            models.Index(fields=["partner"], name="ix_journal_line_partner"),
        ]


# --- Sub-ledgers: open items, supplier invoices, payments, banking, budgets ----------------------


class MatchTolerance(CompanyScopedModel, VersionedModel):
    """Three-way match tolerances (D-08) — data, per company and optionally per supplier."""

    supplier = models.ForeignKey("partners.Partner", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    price_pct = models.DecimalField(max_digits=7, decimal_places=3, default=2)
    price_abs = MoneyField(default=500)
    quantity_pct = models.DecimalField(max_digits=7, decimal_places=3, default=0)

    authz_resource_type = "finance.posting_rule"

    class Meta:
        db_table = "match_tolerances"
        constraints = [
            models.UniqueConstraint(
                fields=["company", "supplier"], name="uq_tolerance_supplier", condition=Q(supplier__isnull=False)
            ),
            models.UniqueConstraint(
                fields=["company"], name="uq_tolerance_default", condition=Q(supplier__isnull=True)
            ),
        ]


class OpenItem(AuthzResourceMixin, UUIDModel):
    """A receivable or payable document awaiting settlement (credit notes/advances are negative)."""

    class Kind(models.TextChoices):
        RECEIVABLE = "receivable"
        PAYABLE = "payable"

    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    partner = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    document_type = models.CharField(max_length=100)
    document_id = models.UUIDField()
    number = models.CharField(max_length=60)
    document_date = models.DateField()
    due_date = models.DateField()
    amount = MoneyField()
    settled = MoneyField(default=0)
    is_open = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    authz_resource_type = "finance.open_item"
    authz_scope_fields = {"company": "company_id"}

    class Meta:
        db_table = "open_items"
        constraints = [models.UniqueConstraint(fields=["document_type", "document_id"], name="uq_open_item_document")]
        indexes = [models.Index(fields=["company", "partner", "kind", "is_open"], name="ix_open_item_partner")]

    @property
    def outstanding(self):
        return self.amount - self.settled


class SupplierInvoice(CompanyScopedModel, VersionedModel):
    class Match(models.TextChoices):
        PENDING = "pending"
        MATCHED = "matched"
        VARIANCE = "variance"

    number = models.CharField(max_length=40, blank=True)
    supplier = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    supplier_invoice_number = models.CharField(max_length=60)
    invoice_date = models.DateField()
    due_date = models.DateField(null=True, blank=True)
    purchase_order = models.ForeignKey(
        "procurement.PurchaseOrder", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    intra_state = models.BooleanField(default=True)
    status = models.CharField(max_length=12, default="draft")
    match_status = models.CharField(max_length=10, choices=Match.choices, default=Match.PENDING)
    match_notes = models.JSONField(default=list, blank=True)
    subtotal = MoneyField(default=0)
    cgst = MoneyField(default=0)
    sgst = MoneyField(default=0)
    igst = MoneyField(default=0)
    amount = MoneyField(default=0)  # total payable (used for approval limits)
    currency = models.CharField(max_length=3, default="INR")
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    journal_entry = models.ForeignKey(JournalEntry, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    authz_resource_type = "finance.supplier_invoice"

    class Meta:
        db_table = "supplier_invoices"
        constraints = [
            models.UniqueConstraint(
                fields=["company", "supplier", "supplier_invoice_number"],
                name="uq_supplier_invoice_number",
                condition=~Q(status="cancelled"),
            )
        ]


class SupplierInvoiceLine(UUIDModel):
    invoice = models.ForeignKey(SupplierInvoice, on_delete=models.CASCADE, related_name="lines")
    grn_line = models.ForeignKey(
        "procurement.GoodsReceiptLine", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    po_line = models.ForeignKey("procurement.PurchaseOrderLine", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(max_digits=20, decimal_places=6)  # order UoM
    rate = models.DecimalField(max_digits=20, decimal_places=6)
    gst_rate = models.DecimalField(max_digits=9, decimal_places=4, default=0)
    taxable_amount = MoneyField(default=0)
    cgst = MoneyField(default=0)
    sgst = MoneyField(default=0)
    igst = MoneyField(default=0)

    class Meta:
        db_table = "supplier_invoice_lines"


class BankAccount(CompanyScopedModel, VersionedModel):
    account = models.OneToOneField(Account, on_delete=models.PROTECT, related_name="bank_account")
    bank_name = models.CharField(max_length=150)
    ifsc = models.CharField(max_length=11, blank=True)
    account_last4 = models.CharField(max_length=4, blank=True)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "finance.bank_account"

    class Meta:
        db_table = "bank_accounts"


class Payment(CompanyScopedModel, VersionedModel):
    class Kind(models.TextChoices):
        SUPPLIER_PAYMENT = "supplier_payment"
        CUSTOMER_RECEIPT = "customer_receipt"

    class Mode(models.TextChoices):
        NEFT = "neft"
        RTGS = "rtgs"
        IMPS = "imps"
        UPI = "upi"
        CHEQUE = "cheque"
        CASH = "cash"

    number = models.CharField(max_length=40, blank=True)
    kind = models.CharField(max_length=20, choices=Kind.choices)
    partner = models.ForeignKey("partners.Partner", on_delete=models.PROTECT, related_name="+")
    bank_account = models.ForeignKey(BankAccount, on_delete=models.PROTECT, related_name="payments")
    payment_date = models.DateField()
    mode = models.CharField(max_length=10, choices=Mode.choices)
    reference = models.CharField(max_length=80, blank=True)
    amount = MoneyField()
    currency = models.CharField(max_length=3, default="INR")
    status = models.CharField(max_length=12, default="draft")
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    partner_bank_account = models.ForeignKey(
        "partners.PartnerBankAccount", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    journal_entry = models.ForeignKey(JournalEntry, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    advance_item = models.ForeignKey(OpenItem, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    authz_resource_type = "finance.payment"

    class Meta:
        db_table = "payments"
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="ck_payment_positive")]


class PaymentAllocation(UUIDModel):
    payment = models.ForeignKey(Payment, on_delete=models.CASCADE, related_name="allocations")
    open_item = models.ForeignKey(OpenItem, on_delete=models.PROTECT, related_name="allocations")
    amount = MoneyField()

    class Meta:
        db_table = "payment_allocations"
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="ck_allocation_positive")]


class BankStatementLine(CompanyScopedModel):
    class Status(models.TextChoices):
        UNMATCHED = "unmatched"
        MATCHED = "matched"
        IGNORED = "ignored"

    bank_account = models.ForeignKey(BankAccount, on_delete=models.PROTECT, related_name="statement_lines")
    import_batch = models.UUIDField()
    txn_date = models.DateField()
    description = models.CharField(max_length=300)
    reference = models.CharField(max_length=100, blank=True)
    amount = MoneyField()  # deposits positive, withdrawals negative
    balance = MoneyField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.UNMATCHED)
    matched_line = models.OneToOneField(
        JournalLine, null=True, blank=True, on_delete=models.PROTECT, related_name="statement_line"
    )
    matched_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "finance.bank_account"

    class Meta:
        db_table = "bank_statement_lines"
        indexes = [models.Index(fields=["bank_account", "status", "txn_date"], name="ix_statement_status")]


class Budget(CompanyScopedModel, VersionedModel):
    fiscal_year = models.ForeignKey("organization.FiscalYear", on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=120)
    status = models.CharField(max_length=10, default="draft")  # draft | approved

    authz_resource_type = "finance.budget"

    class Meta:
        db_table = "budgets"


class BudgetLine(UUIDModel):
    budget = models.ForeignKey(Budget, on_delete=models.CASCADE, related_name="lines")
    account = models.ForeignKey(Account, on_delete=models.PROTECT, related_name="+")
    cost_center = models.ForeignKey(CostCenter, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    period_no = models.PositiveSmallIntegerField()
    amount = MoneyField()

    class Meta:
        db_table = "budget_lines"
        constraints = [
            models.UniqueConstraint(fields=["budget", "account", "cost_center", "period_no"], name="uq_budget_line")
        ]
