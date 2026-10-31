"""Inspections release or block stock held in `quality_hold`; outcomes feed supplier ratings."""

from __future__ import annotations

from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import InvalidStateTransition
from apps.core.outbox import publish_event
from apps.inventory.engine import Move, post_stock
from apps.inventory.models import StockStatus
from apps.organization.services import allocate_number

from .models import Inspection, InspectionPlan, NonConformance


def create_inspection(
    ctx: ActorContext,
    *,
    company_id,
    stage: str,
    item,
    warehouse,
    quantity,
    source_type: str,
    source_id,
    source_line_id=None,
    batch=None,
    serials=None,
    supplier=None,
    on=None,
) -> Inspection:
    """Called by GRN and production services inside their transaction."""
    plan = InspectionPlan.objects.filter(item=item, stage=stage, is_active=True).first()
    inspection = Inspection.objects.create(
        company_id=company_id,
        stage=stage,
        item=item,
        warehouse=warehouse,
        batch=batch,
        serials=serials or [],
        quantity=quantity,
        supplier=supplier,
        source_type=source_type,
        source_id=source_id,
        source_line_id=source_line_id,
        plan=plan,
        created_by=ctx.user,
        updated_by=ctx.user,
        number=allocate_number(company_id, "QI", on or timezone.localdate()),
    )
    publish_event(
        "quality.inspection.created",
        aggregate_type="quality.inspection",
        aggregate_id=inspection.pk,
        company_id=company_id,
    )
    return inspection


def _evaluate(plan: InspectionPlan | None, results: list[dict]) -> list[dict]:
    """Mark each measured parameter in/out of tolerance against the plan."""
    if plan is None:
        return results
    spec = {p["name"]: p for p in plan.parameters}
    out = []
    for r in results:
        p = spec.get(r.get("name"), {})
        ok = r.get("passed")
        if p.get("kind") == "numeric" and r.get("value") not in (None, ""):
            v = Decimal(str(r["value"]))
            ok = (p.get("min") is None or v >= Decimal(str(p["min"]))) and (
                p.get("max") is None or v <= Decimal(str(p["max"]))
            )
        out.append({**r, "passed": bool(ok)})
    return out


@transaction.atomic
def decide(
    ctx: ActorContext,
    inspection: Inspection,
    *,
    accepted_quantity: Decimal,
    rejected_quantity: Decimal,
    results: list[dict] | None = None,
    remarks: str = "",
    on=None,
    ncr_description: str = "",
    expected_version=None,
) -> Inspection:
    inspection = (
        Inspection.objects.select_for_update(of=("self",))
        .select_related("item__category", "warehouse")
        .get(pk=inspection.pk)
    )
    if inspection.status != Inspection.Status.PENDING:
        raise InvalidStateTransition("The inspection is already decided.")
    if expected_version is not None and inspection.version != expected_version:
        from apps.core.exceptions import VersionConflict

        raise VersionConflict()
    pdp.require(ctx, "quality.inspection.approve", pdp.Resource.of(inspection))
    accepted_quantity, rejected_quantity = Decimal(accepted_quantity), Decimal(rejected_quantity)
    if accepted_quantity < 0 or rejected_quantity < 0 or accepted_quantity + rejected_quantity != inspection.quantity:
        raise ValidationError(
            {
                "accepted_quantity": [
                    f"Accepted plus rejected must equal the inspected quantity ({inspection.quantity.normalize()})."
                ]
            }
        )
    if rejected_quantity > 0 and not (ncr_description or remarks):
        raise ValidationError({"remarks": ["Say why material was rejected."]})
    on = on or timezone.localdate()
    moves = []
    for qty, target in ((accepted_quantity, StockStatus.UNRESTRICTED), (rejected_quantity, StockStatus.BLOCKED)):
        if qty > 0:
            moves += [
                Move(
                    item=inspection.item,
                    warehouse=inspection.warehouse,
                    quantity=-qty,
                    movement_type="status_out",
                    stock_status=StockStatus.QUALITY_HOLD,
                    batch=inspection.batch,
                    allow_expired=True,
                    source_line_id=inspection.source_line_id,
                ),
                Move(
                    item=inspection.item,
                    warehouse=inspection.warehouse,
                    quantity=qty,
                    movement_type="status_in",
                    stock_status=target,
                    batch=inspection.batch,
                    value_from_previous=True,
                    source_line_id=inspection.source_line_id,
                ),
            ]
    post_stock(
        ctx,
        company_id=inspection.company_id,
        posting_date=on,
        moves=moves,
        source_type="quality.inspection",
        source_id=inspection.pk,
        reference=inspection.number,
        narration=f"Inspection {inspection.number}",
    )
    status = (
        Inspection.Status.ACCEPTED
        if rejected_quantity == 0
        else Inspection.Status.REJECTED
        if accepted_quantity == 0
        else Inspection.Status.PARTIAL
    )
    inspection.accepted_quantity, inspection.rejected_quantity, inspection.status = (
        accepted_quantity,
        rejected_quantity,
        status,
    )
    inspection.results, inspection.remarks = _evaluate(inspection.plan, results or []), remarks
    inspection.inspected_by, inspection.decided_at = ctx.user, timezone.now()
    inspection.version += 1
    inspection.save()
    if rejected_quantity > 0:
        NonConformance.objects.create(
            company_id=inspection.company_id,
            inspection=inspection,
            description=ncr_description or remarks,
            created_by=ctx.user,
            updated_by=ctx.user,
            number=allocate_number(inspection.company_id, "NCR", on),
        )
    if inspection.supplier_id:
        update_supplier_rating(inspection.supplier)
    audit.record(
        "quality.inspection.decided",
        ctx=ctx,
        resource_type="quality.inspection",
        resource_id=inspection.pk,
        company_id=inspection.company_id,
        changes={"accepted": str(accepted_quantity), "rejected": str(rejected_quantity), "status": status},
    )
    publish_event(
        "quality.inspection.decided",
        aggregate_type="quality.inspection",
        aggregate_id=inspection.pk,
        company_id=inspection.company_id,
        payload={"status": status, "source_type": inspection.source_type, "source_id": str(inspection.source_id)},
    )
    return inspection


def update_supplier_rating(supplier) -> Decimal | None:
    """Rating = accepted share of quantity over the supplier's last 50 decided receipt inspections."""
    recent = (
        Inspection.objects.filter(supplier=supplier, stage="receipt")
        .exclude(status="pending")
        .order_by("-decided_at")[:50]
    )
    totals = Inspection.objects.filter(pk__in=[i.pk for i in recent]).aggregate(
        a=Sum("accepted_quantity"), q=Sum("quantity")
    )
    if not totals["q"]:
        return None
    rating = (Decimal(totals["a"] or 0) * 100 / totals["q"]).quantize(Decimal("0.01"))
    profile = getattr(supplier, "supplier_profile", None)
    if profile is not None:
        type(profile).objects.filter(pk=profile.pk).update(rating=rating)
    return rating


@transaction.atomic
def close_ncr(ctx: ActorContext, ncr: NonConformance, *, disposition: str, corrective_action: str) -> NonConformance:
    ncr = NonConformance.objects.select_for_update().get(pk=ncr.pk)
    if ncr.status != NonConformance.Status.OPEN:
        raise InvalidStateTransition("The NCR is already closed.")
    pdp.require(ctx, "quality.ncr.update", pdp.Resource.of(ncr))
    if not corrective_action.strip():
        raise ValidationError({"corrective_action": ["Describe the corrective action."]})
    ncr.disposition, ncr.corrective_action = disposition, corrective_action
    ncr.status, ncr.closed_by = NonConformance.Status.CLOSED, ctx.user
    ncr.version += 1
    ncr.save()
    return ncr
