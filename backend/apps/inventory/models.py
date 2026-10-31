import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q, Value
from django.db.models.functions import Coalesce

from apps.core.fields import MoneyField, QuantityField, RateField
from apps.core.models import ActorStampedModel, AuthzResourceMixin, CompanyScopedModel, UUIDModel, VersionedModel

ZERO_UUID = uuid.UUID(int=0)
STOCK_STATUSES = ["unrestricted", "quality_hold", "blocked", "in_transit"]


class StockStatus(models.TextChoices):
    UNRESTRICTED = "unrestricted"
    QUALITY_HOLD = "quality_hold"
    BLOCKED = "blocked"
    IN_TRANSIT = "in_transit"


class Location(CompanyScopedModel, VersionedModel):
    class Kind(models.TextChoices):
        ZONE = "zone"
        RACK = "rack"
        BIN = "bin"

    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="locations")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    code = models.CharField(max_length=40)
    name = models.CharField(max_length=120, blank=True)
    kind = models.CharField(max_length=5, choices=Kind.choices, default=Kind.BIN)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "inventory.location"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "inv_locations"
        constraints = [models.UniqueConstraint(fields=["warehouse", "code"], name="uq_location_code")]


class Batch(CompanyScopedModel):
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="batches")
    batch_number = models.CharField(max_length=60)
    manufactured_on = models.DateField(null=True, blank=True)
    expires_on = models.DateField(null=True, blank=True)
    supplier_batch = models.CharField(max_length=60, blank=True)

    authz_resource_type = "inventory.batch"

    class Meta:
        db_table = "inv_batches"
        constraints = [models.UniqueConstraint(fields=["company", "item", "batch_number"], name="uq_batch_number")]


class SerialNumber(CompanyScopedModel):
    class Status(models.TextChoices):
        IN_STOCK = "in_stock"
        ISSUED = "issued"
        SCRAPPED = "scrapped"

    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="serials")
    serial = models.CharField(max_length=80)
    batch = models.ForeignKey(Batch, null=True, blank=True, on_delete=models.PROTECT, related_name="serials")
    status = models.CharField(max_length=10, choices=Status.choices)
    warehouse = models.ForeignKey(
        "organization.Warehouse", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    location = models.ForeignKey(Location, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    stock_status = models.CharField(max_length=15, choices=StockStatus.choices, blank=True)

    authz_resource_type = "inventory.batch"

    class Meta:
        db_table = "inv_serial_numbers"
        constraints = [models.UniqueConstraint(fields=["company", "item", "serial"], name="uq_serial_number")]


class StockTransaction(AuthzResourceMixin, UUIDModel):
    """Header grouping the ledger entries of one posting (and its journal entry)."""

    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    posting_date = models.DateField()
    source_type = models.CharField(max_length=100)
    source_id = models.UUIDField()
    reference = models.CharField(max_length=80, blank=True)
    journal_entry = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    posted_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+")
    posted_at = models.DateTimeField(auto_now_add=True)

    authz_resource_type = "inventory.stock_ledger"
    authz_scope_fields = {"company": "company_id"}

    class Meta:
        db_table = "stock_transactions"
        indexes = [models.Index(fields=["source_type", "source_id"], name="ix_stock_txn_source")]


class StockLedgerEntry(AuthzResourceMixin, UUIDModel):
    """Authoritative, append-only (DB trigger). Quantities are in the item's stock UoM, signed."""

    transaction = models.ForeignKey(StockTransaction, on_delete=models.PROTECT, related_name="entries")
    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    location = models.ForeignKey(Location, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    batch = models.ForeignKey(Batch, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    movement_type = models.CharField(max_length=30)
    stock_status = models.CharField(max_length=15, choices=StockStatus.choices)
    quantity = QuantityField()
    unit_cost = RateField()
    value = MoneyField()
    balance_quantity_after = QuantityField()
    balance_value_after = MoneyField()
    posting_date = models.DateField()
    source_type = models.CharField(max_length=100)
    source_id = models.UUIDField()
    source_line_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    authz_resource_type = "inventory.stock_ledger"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "stock_ledger_entries"
        constraints = [models.CheckConstraint(condition=~Q(quantity=0), name="ck_ledger_nonzero_quantity")]
        indexes = [
            models.Index(fields=["company", "item", "warehouse", "posting_date"], name="ix_ledger_item_wh_date"),
            models.Index(fields=["source_type", "source_id"], name="ix_ledger_source"),
        ]


class StockLedgerSerial(UUIDModel):
    entry = models.ForeignKey(StockLedgerEntry, on_delete=models.PROTECT, related_name="serial_links")
    serial = models.ForeignKey(SerialNumber, on_delete=models.PROTECT, related_name="ledger_links")

    class Meta:
        db_table = "stock_ledger_serials"


class StockBalance(AuthzResourceMixin, UUIDModel):
    """Derived cache of on-hand quantity by bin, batch and status. Rebuildable from the ledger."""

    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    location = models.ForeignKey(Location, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    batch = models.ForeignKey(Batch, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    stock_status = models.CharField(max_length=15, choices=StockStatus.choices)
    quantity = QuantityField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    authz_resource_type = "inventory.stock_balance"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "stock_balances"
        constraints = [
            models.UniqueConstraint(
                "company",
                "item",
                "warehouse",
                Coalesce("location", Value(ZERO_UUID)),
                Coalesce("batch", Value(ZERO_UUID)),
                "stock_status",
                name="uq_stock_balance_bucket",
            ),
        ]
        indexes = [models.Index(fields=["company", "item", "warehouse"], name="ix_balance_item_wh")]


class ItemValuation(AuthzResourceMixin, UUIDModel):
    """Moving weighted average per company × item × warehouse (D-01). Also the lock that
    serialises every stock operation on that item in that warehouse."""

    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField(default=0)
    value = MoneyField(default=0)
    avg_cost = RateField(default=0)
    reserved_quantity = QuantityField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    authz_resource_type = "inventory.stock_balance"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "item_valuations"
        constraints = [
            models.UniqueConstraint(fields=["company", "item", "warehouse"], name="uq_item_valuation"),
            models.CheckConstraint(condition=Q(reserved_quantity__gte=0), name="ck_reserved_non_negative"),
        ]


class StockReservation(AuthzResourceMixin, ActorStampedModel):
    class Status(models.TextChoices):
        ACTIVE = "active"
        CONSUMED = "consumed"
        RELEASED = "released"

    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField()
    consumed_quantity = QuantityField(default=0)
    source_type = models.CharField(max_length=100)
    source_id = models.UUIDField()
    source_line_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.ACTIVE)

    authz_resource_type = "inventory.reservation"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "stock_reservations"
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_reservation_positive"),
            models.CheckConstraint(
                condition=Q(consumed_quantity__gte=0) & Q(consumed_quantity__lte=models.F("quantity")),
                name="ck_reservation_consumed",
            ),
        ]
        indexes = [models.Index(fields=["source_type", "source_id"], name="ix_reservation_source")]

    @property
    def remaining(self):
        return self.quantity - self.consumed_quantity


# --- Documents --------------------------------------------------------------------------------


class DocStatus(models.TextChoices):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    POSTED = "posted"
    CANCELLED = "cancelled"


class StockAdjustment(CompanyScopedModel, VersionedModel):
    class Reason(models.TextChoices):
        DAMAGE = "damage"
        EXPIRY = "expiry"
        FOUND = "found"
        LOSS = "loss"
        OPENING = "opening_balance"
        CORRECTION = "correction"

    number = models.CharField(max_length=40, blank=True)
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    posting_date = models.DateField()
    reason = models.CharField(max_length=20, choices=Reason.choices)
    notes = models.TextField(blank=True)
    status = models.CharField(max_length=10, choices=DocStatus.choices, default=DocStatus.DRAFT)
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    stock_transaction = models.ForeignKey(
        StockTransaction, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    amount = MoneyField(default=0)  # absolute value at submission, used for approval limits
    currency = models.CharField(max_length=3, default="INR")

    authz_resource_type = "inventory.stock_adjustment"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "stock_adjustments"


class StockAdjustmentLine(UUIDModel):
    adjustment = models.ForeignKey(StockAdjustment, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    location = models.ForeignKey(Location, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    batch_number = models.CharField(max_length=60, blank=True)
    expires_on = models.DateField(null=True, blank=True)
    serials = models.JSONField(default=list, blank=True)
    quantity = QuantityField()  # signed, stock UoM
    unit_cost = RateField(null=True, blank=True)  # gains only; defaults to current average cost

    class Meta:
        db_table = "stock_adjustment_lines"
        constraints = [models.CheckConstraint(condition=~Q(quantity=0), name="ck_adjustment_line_nonzero")]


class StockTransfer(CompanyScopedModel, VersionedModel):
    class Status(models.TextChoices):
        DRAFT = "draft"
        DISPATCHED = "dispatched"
        RECEIVED = "received"
        CANCELLED = "cancelled"

    number = models.CharField(max_length=40, blank=True)
    from_warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    to_warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    dispatched_on = models.DateField(null=True, blank=True)
    received_on = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True)
    dispatched_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    received_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "inventory.stock_transfer"
    authz_scope_fields = {"company": "company_id", "warehouse": "from_warehouse_id"}

    class Meta:
        db_table = "stock_transfers"
        constraints = [
            models.CheckConstraint(
                condition=~Q(from_warehouse=models.F("to_warehouse")), name="ck_transfer_distinct_warehouses"
            )
        ]


class StockTransferLine(UUIDModel):
    transfer = models.ForeignKey(StockTransfer, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    batch = models.ForeignKey(Batch, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    serials = models.JSONField(default=list, blank=True)
    quantity = QuantityField()
    from_location = models.ForeignKey(Location, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    to_location = models.ForeignKey(Location, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    class Meta:
        db_table = "stock_transfer_lines"
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_transfer_line_positive")]


class StockCount(CompanyScopedModel, VersionedModel):
    class Status(models.TextChoices):
        COUNTING = "counting"
        SUBMITTED = "submitted"
        POSTED = "posted"
        CANCELLED = "cancelled"

    number = models.CharField(max_length=40, blank=True)
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    count_date = models.DateField()
    blind = models.BooleanField(default=True)  # counters don't see system quantities
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.COUNTING)
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    stock_transaction = models.ForeignKey(
        StockTransaction, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "inventory.stock_count"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "stock_counts"


class StockCountLine(UUIDModel):
    count = models.ForeignKey(StockCount, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    location = models.ForeignKey(Location, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    batch = models.ForeignKey(Batch, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    system_quantity = QuantityField()  # frozen when the count starts
    counted_quantity = QuantityField(null=True, blank=True)
    counted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        db_table = "stock_count_lines"
