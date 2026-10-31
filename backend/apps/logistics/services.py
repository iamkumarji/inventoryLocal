from __future__ import annotations

from datetime import date, timedelta

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import BusinessRuleViolation, InvalidStateTransition
from apps.core.outbox import publish_event
from apps.organization.services import allocate_number
from apps.shared import workflow

from .models import Driver, ProofOfDelivery, Shipment, Vehicle

SHIPMENT = "logistics.shipment"
DOC_FIELDS = ("insurance_expires_on", "permit_expires_on", "fitness_expires_on", "puc_expires_on")


def _documents_valid(vehicle: Vehicle | None, driver: Driver | None, on: date) -> list[str]:
    problems = []
    if vehicle is not None:
        for field in DOC_FIELDS:
            value = getattr(vehicle, field)
            if value is not None and value < on:
                problems.append(f"{vehicle.registration}: {field.replace('_expires_on', '')} expired on {value}")
    if driver is not None and driver.licence_expires_on < on:
        problems.append(f"{driver.name}: licence expired on {driver.licence_expires_on}")
    return problems


@transaction.atomic
def plan_shipment(
    ctx: ActorContext,
    *,
    company,
    branch,
    planned_date: date,
    deliveries=(),
    receipts=(),
    vehicle=None,
    driver=None,
    carrier_name: str = "",
    lr_number: str = "",
    direction: str = "outbound",
    freight_cost=0,
) -> Shipment:
    pdp.require(ctx, f"{SHIPMENT}.create", pdp.Resource.ref(SHIPMENT, company_id=company.pk, branch_id=branch.pk))
    if vehicle is None and not carrier_name:
        raise ValidationError({"vehicle": ["Choose a vehicle or name the transporter."]})
    for d in deliveries:
        if d.status != "posted" or d.company_id != company.pk:
            raise ValidationError({"deliveries": ["Only posted deliveries of this company can be shipped."]})
    shipment = Shipment.objects.create(
        company=company,
        branch=branch,
        planned_date=planned_date,
        vehicle=vehicle,
        driver=driver,
        carrier_name=carrier_name,
        lr_number=lr_number,
        direction=direction,
        freight_cost=freight_cost,
        created_by=ctx.user,
        updated_by=ctx.user,
        number=allocate_number(company.pk, "SHP", planned_date),
    )
    shipment.deliveries.set(deliveries)
    shipment.receipts.set(receipts)
    return shipment


@transaction.atomic
def dispatch(ctx: ActorContext, shipment: Shipment) -> Shipment:
    shipment = Shipment.objects.select_for_update(of=("self",)).select_related("vehicle", "driver").get(pk=shipment.pk)
    if shipment.status != Shipment.Status.PLANNED:
        raise InvalidStateTransition("Only planned shipments can be dispatched.")
    pdp.require(ctx, f"{SHIPMENT}.dispatch", pdp.Resource.of(shipment))
    problems = _documents_valid(shipment.vehicle, shipment.driver, timezone.localdate())
    if problems:
        raise BusinessRuleViolation(
            "Vehicle or driver documents have expired.", code="documents_expired", meta={"problems": problems}
        )
    workflow.bump(shipment, ctx, status=Shipment.Status.DISPATCHED, dispatched_at=timezone.now())
    publish_event(
        "logistics.shipment.dispatched",
        aggregate_type=SHIPMENT,
        aggregate_id=shipment.pk,
        company_id=shipment.company_id,
    )
    return shipment


@transaction.atomic
def record_proof(
    ctx: ActorContext,
    shipment: Shipment,
    *,
    delivery,
    outcome: str,
    received_by_name: str,
    received_at=None,
    latitude=None,
    longitude=None,
    signature_document_id=None,
    photo_document_id=None,
    remarks: str = "",
) -> ProofOfDelivery:
    """Drivers record POD for their own trips (ABAC: resource.owner_id == subject.id) or dispatchers in scope."""
    shipment = Shipment.objects.select_for_update().get(pk=shipment.pk)
    if shipment.status not in (Shipment.Status.DISPATCHED, Shipment.Status.PARTIAL):
        raise InvalidStateTransition("Proof of delivery is recorded for dispatched shipments.")
    pdp.require(ctx, f"{SHIPMENT}.deliver", pdp.Resource.of(shipment))
    if not shipment.deliveries.filter(pk=delivery.pk).exists():
        raise ValidationError({"delivery": ["Not part of this shipment."]})
    if outcome != ProofOfDelivery.Outcome.REFUSED and not (signature_document_id or photo_document_id):
        raise ValidationError({"signature_document_id": ["Attach a signature or a photo."]})
    pod = ProofOfDelivery.objects.create(
        shipment=shipment,
        delivery=delivery,
        outcome=outcome,
        received_by_name=received_by_name,
        received_at=received_at or timezone.now(),
        latitude=latitude,
        longitude=longitude,
        signature_document_id=signature_document_id,
        photo_document_id=photo_document_id,
        remarks=remarks,
        recorded_by=ctx.user,
    )
    done = shipment.proofs.count()
    total = shipment.deliveries.count()
    status = Shipment.Status.DELIVERED if done == total else Shipment.Status.PARTIAL
    workflow.bump(shipment, ctx, status=status, completed_at=timezone.now() if done == total else None)
    audit.record(
        "logistics.pod.recorded",
        ctx=ctx,
        resource_type=SHIPMENT,
        resource_id=shipment.pk,
        company_id=shipment.company_id,
        summary=f"{delivery.number}: {outcome}",
    )
    return pod


def expiring_documents(company_id, within_days: int = 30) -> list[dict]:
    horizon = timezone.localdate() + timedelta(days=within_days)
    rows = []
    for v in Vehicle.objects.filter(company_id=company_id, is_active=True):
        for field in DOC_FIELDS:
            value = getattr(v, field)
            if value is not None and value <= horizon:
                rows.append(
                    {
                        "kind": "vehicle",
                        "id": str(v.pk),
                        "name": v.registration,
                        "document": field.replace("_expires_on", ""),
                        "expires_on": value,
                    }
                )
    for d in Driver.objects.filter(company_id=company_id, is_active=True, licence_expires_on__lte=horizon):
        rows.append(
            {
                "kind": "driver",
                "id": str(d.pk),
                "name": d.name,
                "document": "licence",
                "expires_on": d.licence_expires_on,
            }
        )
    return sorted(rows, key=lambda r: r["expires_on"])
