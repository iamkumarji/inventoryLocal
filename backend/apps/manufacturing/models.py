from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.fields import MoneyField, PercentField, QuantityField, RateField
from apps.core.models import (
    ActorStampedModel,
    CompanyScopedModel,
    SharedMasterMixin,
    UUIDModel,
    VersionedModel,
)


class WorkCenter(CompanyScopedModel, VersionedModel):
    facility = models.ForeignKey("organization.Facility", on_delete=models.PROTECT, related_name="+")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=150)
    capacity_hours_per_day = models.DecimalField(max_digits=6, decimal_places=2, default=8)
    labour_rate = RateField(default=0)  # per hour
    machine_rate = RateField(default=0)  # per hour
    overhead_rate = RateField(default=0)  # per hour
    is_active = models.BooleanField(default=True)

    authz_resource_type = "manufacturing.work_center"
    authz_scope_fields = {"company": "company_id", "facility": "facility_id"}

    class Meta:
        db_table = "work_centers"
        constraints = [models.UniqueConstraint(fields=["company", "code"], name="uq_work_center_code")]


class Bom(SharedMasterMixin, VersionedModel, ActorStampedModel):
    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="boms")
    code = models.CharField(max_length=40)
    name = models.CharField(max_length=200)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "manufacturing.bom"

    class Meta:
        db_table = "boms"
        constraints = [models.UniqueConstraint(fields=["organization", "code"], name="uq_bom_code")]


class BomVersion(SharedMasterMixin, ActorStampedModel):
    class Status(models.TextChoices):
        DRAFT = "draft"
        APPROVED = "approved"
        OBSOLETE = "obsolete"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    bom = models.ForeignKey(Bom, on_delete=models.PROTECT, related_name="versions")
    version_no = models.PositiveIntegerField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    output_quantity = QuantityField(default=1)  # component quantities are per this many units of output
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    notes = models.TextField(blank=True)

    authz_resource_type = "manufacturing.bom"

    class Meta:
        db_table = "bom_versions"
        constraints = [
            models.UniqueConstraint(fields=["bom", "version_no"], name="uq_bom_version_no"),
            models.CheckConstraint(condition=Q(output_quantity__gt=0), name="ck_bom_output_positive"),
        ]


class BomComponent(UUIDModel):
    class IssueMethod(models.TextChoices):
        MANUAL = "manual"
        BACKFLUSH = "backflush"

    version = models.ForeignKey(BomVersion, on_delete=models.CASCADE, related_name="components")
    line_no = models.PositiveSmallIntegerField()
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField()  # stock UoM, per version.output_quantity
    scrap_pct = PercentField(default=0)
    issue_method = models.CharField(max_length=10, choices=IssueMethod.choices, default=IssueMethod.MANUAL)

    class Meta:
        db_table = "bom_components"
        ordering = ["line_no"]
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_bom_component_qty")]


class RoutingOperation(UUIDModel):
    version = models.ForeignKey(BomVersion, on_delete=models.CASCADE, related_name="operations")
    sequence = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=120)
    work_center_code = models.CharField(max_length=30)  # resolved to the company's work centre at release
    setup_minutes = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    run_minutes_per_unit = models.DecimalField(max_digits=10, decimal_places=4, default=0)

    class Meta:
        db_table = "routing_operations"
        ordering = ["sequence"]


class ProductionOrder(CompanyScopedModel, VersionedModel):
    class Status(models.TextChoices):
        DRAFT = "draft"
        RELEASED = "released"
        IN_PROGRESS = "in_progress"
        COMPLETED = "completed"
        CLOSED = "closed"
        CANCELLED = "cancelled"

    class Kind(models.TextChoices):
        STANDARD = "standard"
        REWORK = "rework"

    number = models.CharField(max_length=40, blank=True)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.STANDARD)
    parent_order = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="reworks")
    facility = models.ForeignKey("organization.Facility", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    bom_version = models.ForeignKey(BomVersion, on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField()
    planned_start = models.DateField()
    planned_end = models.DateField()
    source_warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    wip_warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    output_warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.DRAFT)
    produced_quantity = QuantityField(default=0)
    scrapped_quantity = QuantityField(default=0)
    material_cost = MoneyField(default=0)  # value of materials consumed into output
    labour_cost = MoneyField(default=0)
    machine_cost = MoneyField(default=0)
    overhead_cost = MoneyField(default=0)
    absorbed_conversion = MoneyField(default=0)  # conversion cost already moved into finished goods
    scrap_cost = MoneyField(default=0)
    released_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    closed_at = models.DateTimeField(null=True, blank=True)
    source_type = models.CharField(max_length=100, blank=True)  # e.g. sales order line that created it
    source_id = models.UUIDField(null=True, blank=True)

    authz_resource_type = "manufacturing.production_order"
    authz_scope_fields = {"company": "company_id", "facility": "facility_id"}

    class Meta:
        db_table = "production_orders"
        constraints = [models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_production_order_qty")]
        indexes = [models.Index(fields=["company", "status"], name="ix_production_status")]


class ProductionMaterial(UUIDModel):
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="materials")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    required_quantity = QuantityField()  # including planned scrap
    per_unit = QuantityField()  # required per unit of output (for proportional consumption)
    issue_method = models.CharField(max_length=10, choices=BomComponent.IssueMethod.choices)
    issued_quantity = QuantityField(default=0)
    consumed_quantity = QuantityField(default=0)
    returned_quantity = QuantityField(default=0)
    reservation = models.ForeignKey(
        "inventory.StockReservation", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        db_table = "production_materials"


class ProductionOperation(UUIDModel):
    order = models.ForeignKey(ProductionOrder, on_delete=models.CASCADE, related_name="operations")
    sequence = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=120)
    work_center = models.ForeignKey(WorkCenter, on_delete=models.PROTECT, related_name="+")
    planned_minutes = models.DecimalField(max_digits=12, decimal_places=2)
    actual_minutes = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    completed_quantity = QuantityField(default=0)

    class Meta:
        db_table = "production_operations"
        ordering = ["sequence"]


class OperationConfirmation(UUIDModel):
    """Append-only record of time booked against an operation (drives labour/overhead cost)."""

    operation = models.ForeignKey(ProductionOperation, on_delete=models.PROTECT, related_name="confirmations")
    minutes = models.DecimalField(max_digits=10, decimal_places=2)
    quantity = QuantityField(default=0)
    operator = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    labour_cost = MoneyField(default=0)
    machine_cost = MoneyField(default=0)
    overhead_cost = MoneyField(default=0)
    confirmed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "operation_confirmations"
        constraints = [models.CheckConstraint(condition=Q(minutes__gt=0), name="ck_confirmation_minutes")]


class ProductionPlan(CompanyScopedModel, VersionedModel):
    number = models.CharField(max_length=40, blank=True)
    facility = models.ForeignKey("organization.Facility", on_delete=models.PROTECT, related_name="+")
    period_start = models.DateField()
    period_end = models.DateField()
    status = models.CharField(max_length=10, default="draft")  # draft | firmed
    notes = models.TextField(blank=True)

    authz_resource_type = "manufacturing.production_plan"
    authz_scope_fields = {"company": "company_id", "facility": "facility_id"}

    class Meta:
        db_table = "production_plans"


class ProductionPlanLine(UUIDModel):
    plan = models.ForeignKey(ProductionPlan, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    quantity = QuantityField()
    due_date = models.DateField()
    production_order = models.ForeignKey(
        ProductionOrder, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        db_table = "production_plan_lines"
