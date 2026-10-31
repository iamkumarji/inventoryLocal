from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.fields import MoneyField
from apps.core.models import CompanyScopedModel, UUIDModel, VersionedModel


class Vehicle(CompanyScopedModel, VersionedModel):
    class Ownership(models.TextChoices):
        OWNED = "owned"
        HIRED = "hired"

    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    registration = models.CharField(max_length=15)
    vehicle_type = models.CharField(max_length=40)
    capacity_kg = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    ownership = models.CharField(max_length=6, choices=Ownership.choices, default=Ownership.OWNED)
    insurance_expires_on = models.DateField(null=True, blank=True)
    permit_expires_on = models.DateField(null=True, blank=True)
    fitness_expires_on = models.DateField(null=True, blank=True)
    puc_expires_on = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "logistics.vehicle"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id"}

    class Meta:
        db_table = "vehicles"
        constraints = [models.UniqueConstraint(fields=["company", "registration"], name="uq_vehicle_registration")]


class Driver(CompanyScopedModel, VersionedModel):
    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    name = models.CharField(max_length=150)
    phone = models.CharField(max_length=20)
    licence_number = models.CharField(max_length=30)
    licence_expires_on = models.DateField()
    is_active = models.BooleanField(default=True)

    authz_resource_type = "logistics.driver"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id"}

    class Meta:
        db_table = "drivers"
        constraints = [models.UniqueConstraint(fields=["company", "licence_number"], name="uq_driver_licence")]


class Shipment(CompanyScopedModel, VersionedModel):
    class Direction(models.TextChoices):
        OUTBOUND = "outbound"
        INBOUND = "inbound"

    class Status(models.TextChoices):
        PLANNED = "planned"
        DISPATCHED = "dispatched"
        DELIVERED = "delivered"
        PARTIAL = "partially_delivered"
        CANCELLED = "cancelled"

    number = models.CharField(max_length=40, blank=True)
    branch = models.ForeignKey("organization.Branch", on_delete=models.PROTECT, related_name="+")
    direction = models.CharField(max_length=8, choices=Direction.choices, default=Direction.OUTBOUND)
    vehicle = models.ForeignKey(Vehicle, null=True, blank=True, on_delete=models.PROTECT, related_name="shipments")
    driver = models.ForeignKey(Driver, null=True, blank=True, on_delete=models.PROTECT, related_name="shipments")
    carrier_name = models.CharField(max_length=150, blank=True)  # hired transporter
    lr_number = models.CharField(max_length=40, blank=True)  # lorry receipt
    planned_date = models.DateField()
    dispatched_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PLANNED)
    freight_cost = MoneyField(default=0)
    deliveries = models.ManyToManyField("sales.Delivery", blank=True, related_name="shipments")
    receipts = models.ManyToManyField("procurement.GoodsReceipt", blank=True, related_name="shipments")

    authz_resource_type = "logistics.shipment"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id"}

    class Meta:
        db_table = "shipments"
        constraints = [
            models.CheckConstraint(
                condition=Q(vehicle__isnull=False) | ~Q(carrier_name=""), name="ck_shipment_has_transport"
            )
        ]

    def authz_attributes(self) -> dict:
        attrs = super().authz_attributes()
        attrs["owner_id"] = self.driver.user_id if self.driver_id and self.driver.user_id else None
        return attrs


class ProofOfDelivery(UUIDModel):
    """Recorded once per delivery and never edited (DB trigger)."""

    class Outcome(models.TextChoices):
        DELIVERED = "delivered"
        PARTIAL = "partial"
        REFUSED = "refused"

    shipment = models.ForeignKey(Shipment, on_delete=models.PROTECT, related_name="proofs")
    delivery = models.OneToOneField("sales.Delivery", on_delete=models.PROTECT, related_name="proof")
    outcome = models.CharField(max_length=10, choices=Outcome.choices)
    received_by_name = models.CharField(max_length=150)
    received_at = models.DateTimeField()
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    signature_document_id = models.UUIDField(null=True, blank=True)
    photo_document_id = models.UUIDField(null=True, blank=True)
    remarks = models.CharField(max_length=500, blank=True)
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "proofs_of_delivery"
