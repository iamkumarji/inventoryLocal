from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.fields import QuantityField
from apps.core.models import ActorStampedModel, CompanyScopedModel, SharedMasterMixin, VersionedModel


class InspectionPlan(SharedMasterMixin, VersionedModel, ActorStampedModel):
    class Stage(models.TextChoices):
        RECEIPT = "receipt"
        IN_PROCESS = "in_process"
        FINAL = "final"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey("masterdata.Item", on_delete=models.CASCADE, related_name="inspection_plans")
    stage = models.CharField(max_length=12, choices=Stage.choices)
    # e.g. [{"name": "Diameter", "kind": "numeric", "min": "9.95", "max": "10.05", "unit": "mm"},
    #       {"name": "Rust", "kind": "pass_fail"}]
    parameters = models.JSONField(default=list)
    sample_size = models.PositiveIntegerField(default=1)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "quality.inspection_plan"

    class Meta:
        db_table = "inspection_plans"
        constraints = [
            models.UniqueConstraint(fields=["item", "stage"], name="uq_inspection_plan", condition=Q(is_active=True))
        ]


class Inspection(CompanyScopedModel, VersionedModel):
    class Status(models.TextChoices):
        PENDING = "pending"
        ACCEPTED = "accepted"
        REJECTED = "rejected"
        PARTIAL = "partially_accepted"

    number = models.CharField(max_length=40, blank=True)
    stage = models.CharField(max_length=12, choices=InspectionPlan.Stage.choices)
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.PROTECT, related_name="+")
    batch = models.ForeignKey("inventory.Batch", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    serials = models.JSONField(default=list, blank=True)
    quantity = QuantityField()
    accepted_quantity = QuantityField(default=0)
    rejected_quantity = QuantityField(default=0)
    supplier = models.ForeignKey("partners.Partner", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    source_type = models.CharField(max_length=100)
    source_id = models.UUIDField()
    source_line_id = models.UUIDField(null=True, blank=True)
    plan = models.ForeignKey(InspectionPlan, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    results = models.JSONField(default=list, blank=True)
    remarks = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    inspected_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    decided_at = models.DateTimeField(null=True, blank=True)

    authz_resource_type = "quality.inspection"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "quality_inspections"
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0), name="ck_inspection_quantity"),
            models.CheckConstraint(
                condition=Q(accepted_quantity__gte=0, rejected_quantity__gte=0), name="ck_inspection_non_negative"
            ),
        ]
        indexes = [models.Index(fields=["company", "status"], name="ix_inspection_status")]


class NonConformance(CompanyScopedModel, VersionedModel):
    class Disposition(models.TextChoices):
        RETURN = "return_to_supplier"
        REWORK = "rework"
        SCRAP = "scrap"
        USE_AS_IS = "use_as_is"

    class Status(models.TextChoices):
        OPEN = "open"
        CLOSED = "closed"

    number = models.CharField(max_length=40, blank=True)
    inspection = models.ForeignKey(Inspection, on_delete=models.PROTECT, related_name="ncrs")
    description = models.TextField()
    disposition = models.CharField(max_length=20, choices=Disposition.choices, blank=True)
    corrective_action = models.TextField(blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN)
    closed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "quality.ncr"

    class Meta:
        db_table = "non_conformances"
