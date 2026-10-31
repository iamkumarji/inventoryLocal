"""Fixed assets, depreciation (D-25: Companies Act SLM/WDV as the primary book) and maintenance.

Rates, lives, salvage percentages and GL accounts are data on the category/asset; nothing is hardcoded.
"""

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.fields import MoneyField, PercentField, QuantityField
from apps.core.models import AuthzResourceMixin, CompanyScopedModel, UUIDModel, VersionedModel


class DepreciationMethod(models.TextChoices):
    SLM = "slm", "Straight line"
    WDV = "wdv", "Written down value"


class AssetCategory(CompanyScopedModel, VersionedModel):
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=150)
    depreciation_method = models.CharField(max_length=3, choices=DepreciationMethod.choices)
    useful_life_months = models.PositiveIntegerField(default=0)  # required for SLM
    wdv_rate = PercentField(default=0)  # annual %, required for WDV
    salvage_pct = PercentField(default=0)  # default residual value as % of cost
    # Optional overrides of the company-wide determination keys
    # (fixed_assets / accumulated_depreciation / depreciation_expense).
    fixed_asset_account = models.ForeignKey(
        "finance.Account", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    accumulated_depreciation_account = models.ForeignKey(
        "finance.Account", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    depreciation_expense_account = models.ForeignKey(
        "finance.Account", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    is_active = models.BooleanField(default=True)

    authz_resource_type = "assets.asset_category"

    class Meta:
        db_table = "asset_categories"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_asset_category_code"),
            models.CheckConstraint(
                condition=Q(depreciation_method__in=["slm", "wdv"]), name="ck_asset_category_method"
            ),
            models.CheckConstraint(
                condition=~Q(depreciation_method="slm") | Q(useful_life_months__gt=0),
                name="ck_asset_category_slm_life",
            ),
            models.CheckConstraint(
                condition=~Q(depreciation_method="wdv") | (Q(wdv_rate__gt=0) & Q(wdv_rate__lte=100)),
                name="ck_asset_category_wdv_rate",
            ),
            models.CheckConstraint(
                condition=Q(salvage_pct__gte=0) & Q(salvage_pct__lt=100), name="ck_asset_category_salvage"
            ),
        ]


class Asset(CompanyScopedModel, VersionedModel):
    class Status(models.TextChoices):
        DRAFT = "draft"
        SUBMITTED = "submitted"  # capitalization routed for approval (above the approver's limit)
        APPROVED = "approved"  # transient: approval outcome before the capitalization journal posts
        REJECTED = "rejected"
        CAPITALIZED = "capitalized"
        DISPOSED = "disposed"

    class DisposalKind(models.TextChoices):
        SALE = "sale"
        SCRAP = "scrap"

    facility = models.ForeignKey("organization.Facility", on_delete=models.PROTECT, related_name="+")
    category = models.ForeignKey(AssetCategory, on_delete=models.PROTECT, related_name="assets")
    code = models.CharField(max_length=40)
    name = models.CharField(max_length=200)
    serial_number = models.CharField(max_length=100, blank=True)
    custodian = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    location = models.CharField(max_length=200, blank=True)
    acquisition_date = models.DateField()
    put_to_use_date = models.DateField(null=True, blank=True)
    capitalization_date = models.DateField(null=True, blank=True)  # journal date; defaults to put-to-use date
    cost = MoneyField()
    salvage_value = MoneyField(default=0)
    # Depreciation terms copied from the category at creation (editable while draft).
    depreciation_method = models.CharField(max_length=3, choices=DepreciationMethod.choices)
    useful_life_months = models.PositiveIntegerField(default=0)
    wdv_rate = PercentField(default=0)
    # Optional contra account for capitalization (e.g. AP/GRNI when capitalized from a supplier invoice);
    # empty means the `default_bank` determination.
    contra_account = models.ForeignKey(
        "finance.Account", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    contra_partner = models.ForeignKey(
        "partners.Partner", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.DRAFT)
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    # Book values (primary book), maintained by capitalization, depreciation runs and disposal.
    accumulated_depreciation = MoneyField(default=0)
    book_value = MoneyField(default=0)
    capitalization_journal = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    capitalized_at = models.DateTimeField(null=True, blank=True)
    disposal_kind = models.CharField(max_length=5, choices=DisposalKind.choices, blank=True)
    disposal_date = models.DateField(null=True, blank=True)
    disposal_proceeds = MoneyField(default=0)
    disposal_gain = MoneyField(default=0)  # negative = loss
    disposal_journal = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    current_meter_reading = QuantityField(null=True, blank=True)

    authz_resource_type = "assets.asset"
    authz_scope_fields = {"company": "company_id", "facility": "facility_id"}

    class Meta:
        db_table = "assets"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_asset_code"),
            models.CheckConstraint(condition=Q(cost__gt=0), name="ck_asset_cost_positive"),
            models.CheckConstraint(
                condition=Q(salvage_value__gte=0) & Q(salvage_value__lt=models.F("cost")), name="ck_asset_salvage"
            ),
            models.CheckConstraint(
                condition=Q(accumulated_depreciation__gte=0)
                & Q(accumulated_depreciation__lte=models.F("cost") - models.F("salvage_value")),
                name="ck_asset_accumulated_range",
            ),
            models.CheckConstraint(
                condition=Q(status__in=["draft", "submitted", "approved", "rejected", "capitalized", "disposed"]),
                name="ck_asset_status",
            ),
        ]
        indexes = [models.Index(fields=["company", "status"], name="ix_asset_status")]

    @property
    def amount(self):
        """Approval amount read by the PDP (approval limits) and the approvals engine."""
        return self.cost

    @property
    def number(self) -> str:
        return self.code


class DepreciationRun(CompanyScopedModel, VersionedModel):
    class Status(models.TextChoices):
        DRAFT = "draft"
        POSTED = "posted"
        REVERSED = "reversed"

    period = models.DateField()  # first day of the month depreciated
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    total_amount = MoneyField(default=0)
    asset_count = models.PositiveIntegerField(default=0)
    journal_entry = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    posted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    posted_at = models.DateTimeField(null=True, blank=True)
    reversal_journal = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    reversed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    reversed_at = models.DateTimeField(null=True, blank=True)
    reversal_reason = models.CharField(max_length=300, blank=True)

    authz_resource_type = "assets.depreciation_run"

    class Meta:
        db_table = "depreciation_runs"
        constraints = [
            # One live run per company and month; a reversed run frees the month for a corrected re-run.
            models.UniqueConstraint(
                fields=["company", "period"],
                condition=Q(status__in=["draft", "posted"]),
                name="uq_depreciation_run_period",
            ),
            models.CheckConstraint(condition=Q(period__day=1), name="ck_depreciation_run_period_start"),
            models.CheckConstraint(
                condition=Q(status__in=["draft", "posted", "reversed"]), name="ck_depreciation_run_status"
            ),
        ]


class DepreciationEntry(UUIDModel):
    """Immutable per-asset result of a posted run (append-only at the database)."""

    run = models.ForeignKey(DepreciationRun, on_delete=models.PROTECT, related_name="entries")
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="depreciation_entries")
    period = models.DateField()
    opening_book_value = MoneyField()
    amount = MoneyField()
    book_value_after = MoneyField()
    days = models.PositiveSmallIntegerField()  # days depreciated in the month (pro-rata in the first month)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "depreciation_entries"
        constraints = [
            models.UniqueConstraint(fields=["run", "asset"], name="uq_depreciation_entry_asset"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="ck_depreciation_entry_amount"),
        ]
        indexes = [models.Index(fields=["asset", "period"], name="ix_depreciation_asset_period")]


class MeterReading(AuthzResourceMixin, UUIDModel):
    """Append-only meter log; readings never decrease (enforced in the service under a row lock)."""

    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    facility = models.ForeignKey("organization.Facility", on_delete=models.PROTECT, related_name="+")
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="meter_readings")
    reading = QuantityField()
    reading_at = models.DateTimeField()
    recorded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    notes = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    authz_resource_type = "assets.meter_reading"
    authz_scope_fields = {"company": "company_id", "facility": "facility_id"}

    class Meta:
        db_table = "asset_meter_readings"
        constraints = [models.CheckConstraint(condition=Q(reading__gte=0), name="ck_meter_reading_non_negative")]
        indexes = [models.Index(fields=["asset", "reading_at"], name="ix_meter_reading_asset")]


class MaintenancePlan(CompanyScopedModel, VersionedModel):
    class Trigger(models.TextChoices):
        CALENDAR = "calendar"
        METER = "meter"

    facility = models.ForeignKey("organization.Facility", on_delete=models.PROTECT, related_name="+")
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="maintenance_plans")
    name = models.CharField(max_length=150)
    trigger = models.CharField(max_length=10, choices=Trigger.choices)
    interval_days = models.PositiveIntegerField(null=True, blank=True)
    interval_meter = QuantityField(null=True, blank=True)
    checklist = models.JSONField(default=list, blank=True)
    next_due_date = models.DateField(null=True, blank=True)
    next_due_meter = QuantityField(null=True, blank=True)
    technician = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    last_generated_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "assets.maintenance_plan"
    authz_scope_fields = {"company": "company_id", "facility": "facility_id"}

    class Meta:
        db_table = "maintenance_plans"
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(trigger="calendar", interval_days__gt=0, next_due_date__isnull=False)
                    | Q(trigger="meter", interval_meter__gt=0, next_due_meter__isnull=False)
                ),
                name="ck_maintenance_plan_trigger",
            ),
        ]


class MaintenanceWorkOrder(CompanyScopedModel, VersionedModel):
    class Kind(models.TextChoices):
        PREVENTIVE = "preventive"
        BREAKDOWN = "breakdown"

    class Status(models.TextChoices):
        OPEN = "open"
        IN_PROGRESS = "in_progress"
        COMPLETED = "completed"
        CLOSED = "closed"
        CANCELLED = "cancelled"

    number = models.CharField(max_length=40, blank=True)
    facility = models.ForeignKey("organization.Facility", on_delete=models.PROTECT, related_name="+")
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name="work_orders")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    plan = models.ForeignKey(
        MaintenancePlan, null=True, blank=True, on_delete=models.PROTECT, related_name="work_orders"
    )
    due_key = models.CharField(max_length=60, blank=True)  # which occurrence of the plan this WO serves
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.OPEN)
    description = models.TextField(blank=True)
    checklist = models.JSONField(default=list, blank=True)
    reported_at = models.DateTimeField()
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    downtime_minutes = models.PositiveIntegerField(default=0)
    technician = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    labour_hours = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    spare_cost = MoneyField(default=0)
    notes = models.TextField(blank=True)

    authz_resource_type = "assets.work_order"
    authz_scope_fields = {"company": "company_id", "facility": "facility_id"}

    class Meta:
        db_table = "maintenance_work_orders"
        constraints = [
            # Generating preventive work orders is idempotent: one WO per plan occurrence.
            models.UniqueConstraint(
                fields=["plan", "due_key"], condition=Q(plan__isnull=False), name="uq_work_order_plan_due"
            ),
            models.CheckConstraint(
                condition=Q(status__in=["open", "in_progress", "completed", "closed", "cancelled"]),
                name="ck_work_order_status",
            ),
            models.CheckConstraint(condition=Q(labour_hours__gte=0), name="ck_work_order_labour"),
        ]
        indexes = [
            models.Index(fields=["company", "status"], name="ix_work_order_status"),
            models.Index(fields=["asset", "kind", "reported_at"], name="ix_work_order_asset_kind"),
        ]


class WorkOrderSpare(UUIDModel):
    """Spare issued to a work order through the inventory engine (append-only)."""

    work_order = models.ForeignKey(MaintenanceWorkOrder, on_delete=models.PROTECT, related_name="spares")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField()
    value = MoneyField()
    stock_transaction = models.ForeignKey("inventory.StockTransaction", on_delete=models.PROTECT, related_name="+")
    issued_on = models.DateField()
    issued_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "maintenance_work_order_spares"
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_work_order_spare_qty")]
