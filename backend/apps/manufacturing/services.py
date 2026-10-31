"""Plan-to-Produce (SRS §3.8). Actual costing (D-02): output is valued at the materials it consumed
plus conversion cost (labour, machine, overhead) booked through operation confirmations."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition
from apps.core.outbox import publish_event
from apps.finance.posting import Line
from apps.inventory import selectors as inv
from apps.inventory.engine import Move, get_or_create_batch, post_stock, release, reserve
from apps.inventory.models import StockStatus
from apps.masterdata.models import Item
from apps.organization.services import allocate_number
from apps.quality import services as quality

from .models import (
    Bom,
    BomComponent,
    BomVersion,
    OperationConfirmation,
    ProductionMaterial,
    ProductionOperation,
    ProductionOrder,
    WorkCenter,
)

PO = "manufacturing.production_order"
Q4 = Decimal("0.0001")
Q6 = Decimal("0.000001")
ZERO = Decimal("0")
MINUTES_PER_HOUR = Decimal("60")


# --- BOMs ---------------------------------------------------------------------------------------


@transaction.atomic
def create_bom_version(
    ctx: ActorContext,
    bom: Bom,
    *,
    effective_from: date,
    output_quantity: Decimal,
    components: list[dict],
    operations: list[dict] | None = None,
    notes: str = "",
) -> BomVersion:
    pdp.require(ctx, "manufacturing.bom.update", pdp.Resource.of(bom))
    if not components:
        raise ValidationError({"components": ["A BOM needs at least one component."]})
    for c in components:
        if c["item"].pk == bom.item_id:
            raise ValidationError({"components": ["An item can't be a component of itself."]})
    last = bom.versions.order_by("-version_no").first()
    version = BomVersion.objects.create(
        organization_id=bom.organization_id,
        bom=bom,
        version_no=(last.version_no + 1 if last else 1),
        effective_from=effective_from,
        output_quantity=output_quantity,
        notes=notes,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for n, c in enumerate(components, start=1):
        BomComponent.objects.create(version=version, line_no=n, **c)
    for op in operations or []:
        version.operations.create(**op)
    _check_cycles(bom.item, set())
    return version


def _effective_version(item: Item, on: date) -> BomVersion | None:
    return (
        BomVersion.objects.filter(
            bom__item=item, bom__is_active=True, status=BomVersion.Status.APPROVED, effective_from__lte=on
        )
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=on))
        .order_by("-effective_from", "-version_no")
        .first()
    )


def _check_cycles(item: Item, path: set) -> None:
    if item.pk in path:
        raise BusinessRuleViolation(f"BOM cycle detected at {item.code}.", code="bom_cycle")
    path = path | {item.pk}
    for comp in (
        BomComponent.objects.filter(version__bom__item=item)
        .exclude(version__status=BomVersion.Status.OBSOLETE)
        .select_related("item")
    ):
        _check_cycles(comp.item, path)


@transaction.atomic
def approve_bom_version(ctx: ActorContext, version: BomVersion) -> BomVersion:
    version = BomVersion.objects.select_for_update(of=("self",)).select_related("bom").get(pk=version.pk)
    if version.status != BomVersion.Status.DRAFT:
        raise InvalidStateTransition("Only draft versions can be approved.")
    if version.created_by_id == ctx.user_id:
        raise AuthorizationDenied(reason="maker_checker")
    pdp.require(ctx, "manufacturing.bom.approve", pdp.Resource.of(version.bom))
    # The newly approved version takes over from its effective date; earlier ones stop the day before.
    BomVersion.objects.filter(
        bom=version.bom,
        status=BomVersion.Status.APPROVED,
        effective_to__isnull=True,
        effective_from__lt=version.effective_from,
    ).update(effective_to=version.effective_from - timedelta(days=1))
    version.status, version.approved_by = BomVersion.Status.APPROVED, ctx.user
    version.save(update_fields=["status", "approved_by", "updated_at"])
    audit.record(
        "manufacturing.bom.approved",
        ctx=ctx,
        resource_type="manufacturing.bom",
        resource_id=version.bom_id,
        summary=f"{version.bom.code} v{version.version_no}",
    )
    return version


def explode(item: Item, quantity: Decimal, on: date, _depth: int = 0) -> dict:
    """Multi-level explosion. Returns the tree and the flattened requirement of purchased components."""
    if _depth > 20:
        raise BusinessRuleViolation("BOM too deep (possible cycle).", code="bom_cycle")
    version = _effective_version(item, on)
    if version is None:
        return {"item_id": str(item.pk), "item_code": item.code, "quantity": quantity, "children": [], "leaf": True}
    factor = Decimal(quantity) / version.output_quantity
    children = []
    for comp in version.components.select_related("item"):
        need = (comp.quantity * factor * (1 + comp.scrap_pct / 100)).quantize(Q6, rounding=ROUND_HALF_UP)
        child = (
            explode(comp.item, need, on, _depth + 1)
            if comp.item.is_manufactured
            else {
                "item_id": str(comp.item.pk),
                "item_code": comp.item.code,
                "quantity": need,
                "children": [],
                "leaf": True,
            }
        )
        children.append(child)
    return {
        "item_id": str(item.pk),
        "item_code": item.code,
        "quantity": quantity,
        "bom_version": version.version_no,
        "children": children,
        "leaf": False,
    }


def flatten(tree: dict) -> dict[str, Decimal]:
    totals: dict[str, Decimal] = defaultdict(Decimal)

    def walk(node, root=False):
        if node["leaf"] and not root:
            totals[node["item_id"]] += node["quantity"]
        for child in node["children"]:
            walk(child)

    walk(tree, root=True)
    return dict(totals)


def availability_check(company_id, item: Item, quantity: Decimal, warehouse, on: date) -> list[dict]:
    rows = []
    for item_id, need in flatten(explode(item, quantity, on)).items():
        avail = inv.availability(company_id, item_id, warehouse.pk)["available"]
        rows.append({"item_id": item_id, "required": need, "available": avail, "shortage": max(need - avail, ZERO)})
    return rows


# --- Production orders --------------------------------------------------------------------------------


@transaction.atomic
def create_order(
    ctx: ActorContext,
    *,
    company,
    facility,
    item: Item,
    quantity: Decimal,
    planned_start: date,
    planned_end: date,
    source_warehouse,
    wip_warehouse,
    output_warehouse,
    kind: str = "standard",
    parent_order=None,
    source_type: str = "",
    source_id=None,
) -> ProductionOrder:
    pdp.require(ctx, f"{PO}.create", pdp.Resource.ref(PO, company_id=company.pk, facility_id=facility.pk))
    if not item.is_manufactured:
        raise ValidationError({"item": [f"{item.code} isn't a manufactured item."]})
    if wip_warehouse.warehouse_type != "wip":
        raise ValidationError({"wip_warehouse": ["Choose a work-in-progress warehouse."]})
    if {source_warehouse.company_id, wip_warehouse.company_id, output_warehouse.company_id} != {company.pk}:
        raise ValidationError({"source_warehouse": ["Warehouses must belong to this company."]})
    version = _effective_version(item, planned_start)
    if version is None:
        raise BusinessRuleViolation(
            f"{item.code} has no approved BOM effective on {planned_start}.", code="no_effective_bom"
        )
    return ProductionOrder.objects.create(
        company=company,
        facility=facility,
        item=item,
        bom_version=version,
        quantity=quantity,
        kind=kind,
        parent_order=parent_order,
        planned_start=planned_start,
        planned_end=planned_end,
        source_warehouse=source_warehouse,
        wip_warehouse=wip_warehouse,
        output_warehouse=output_warehouse,
        source_type=source_type,
        source_id=source_id,
        created_by=ctx.user,
        updated_by=ctx.user,
    )


@transaction.atomic
def release_order(ctx: ActorContext, order: ProductionOrder) -> ProductionOrder:
    """Freeze the BOM and routing into the order and reserve manually issued materials."""
    order = (
        ProductionOrder.objects.select_for_update(of=("self",)).select_related("bom_version", "item").get(pk=order.pk)
    )
    if order.status != ProductionOrder.Status.DRAFT:
        raise InvalidStateTransition("Only draft orders can be released.")
    pdp.require(ctx, f"{PO}.release", pdp.Resource.of(order))
    factor = order.quantity / order.bom_version.output_quantity
    for comp in order.bom_version.components.select_related("item"):
        required = (comp.quantity * factor * (1 + comp.scrap_pct / 100)).quantize(Q6, rounding=ROUND_HALF_UP)
        material = ProductionMaterial.objects.create(
            order=order,
            item=comp.item,
            required_quantity=required,
            per_unit=(required / order.quantity).quantize(Q6),
            issue_method=comp.issue_method,
        )
        material.reservation = reserve(
            ctx,
            company_id=order.company_id,
            item=comp.item,
            warehouse=order.source_warehouse,
            quantity=required,
            source_type=PO,
            source_id=order.pk,
            source_line_id=material.pk,
        )
        material.save(update_fields=["reservation"])
    for op in order.bom_version.operations.all():
        wc = WorkCenter.objects.filter(company_id=order.company_id, code=op.work_center_code, is_active=True).first()
        if wc is None:
            raise BusinessRuleViolation(
                f"Work centre {op.work_center_code} doesn't exist in this company.", code="work_center_missing"
            )
        ProductionOperation.objects.create(
            order=order,
            sequence=op.sequence,
            name=op.name,
            work_center=wc,
            planned_minutes=op.setup_minutes + op.run_minutes_per_unit * order.quantity,
        )
    order.number = allocate_number(order.company_id, "MO", order.planned_start)
    order.status, order.released_by = ProductionOrder.Status.RELEASED, ctx.user
    order.version += 1
    order.save()
    audit.record(
        f"{PO}.released",
        ctx=ctx,
        resource_type=PO,
        resource_id=order.pk,
        company_id=order.company_id,
        summary=f"{order.number}: {order.quantity.normalize()} x {order.item.code}",
    )
    publish_event("manufacturing.order.released", aggregate_type=PO, aggregate_id=order.pk, company_id=order.company_id)
    return order


def _active(order):
    if order.status not in (ProductionOrder.Status.RELEASED, ProductionOrder.Status.IN_PROGRESS):
        raise InvalidStateTransition("The order isn't released.")


@transaction.atomic
def issue_materials(ctx: ActorContext, order: ProductionOrder, *, lines: list[dict], on: date) -> ProductionOrder:
    """Move materials from stores into WIP against the order's reservations."""
    order = (
        ProductionOrder.objects.select_for_update(of=("self",))
        .select_related("source_warehouse", "wip_warehouse")
        .get(pk=order.pk)
    )
    _active(order)
    pdp.require(ctx, f"{PO}.issue", pdp.Resource.of(order))
    moves = []
    for line in lines:
        material = (
            ProductionMaterial.objects.select_for_update(of=("self",))
            .select_related("item__category", "reservation")
            .get(pk=line["material"].pk, order=order)
        )
        qty = Decimal(line["quantity"])
        batch = get_or_create_batch(order.company_id, material.item, line.get("batch_number", ""), create=False)
        moves += [
            Move(
                item=material.item,
                warehouse=order.source_warehouse,
                quantity=-qty,
                movement_type="production_issue",
                batch=batch,
                serials=line.get("serials", []),
                consume_reservation=material.reservation,
                source_line_id=material.pk,
            ),
            Move(
                item=material.item,
                warehouse=order.wip_warehouse,
                quantity=qty,
                movement_type="production_issue_in",
                batch=batch,
                serials=line.get("serials", []),
                value_from_previous=True,
                source_line_id=material.pk,
            ),
        ]
        material.issued_quantity += qty
        material.save(update_fields=["issued_quantity"])
    post_stock(
        ctx,
        company_id=order.company_id,
        posting_date=on,
        moves=moves,
        source_type=PO,
        source_id=order.pk,
        reference=order.number,
        narration=f"Materials issued to {order.number}",
    )
    if order.status == ProductionOrder.Status.RELEASED:
        order.status = ProductionOrder.Status.IN_PROGRESS
    order.version += 1
    order.save()
    return order


@transaction.atomic
def confirm_operation(
    ctx: ActorContext, operation: ProductionOperation, *, minutes: Decimal, quantity: Decimal = ZERO
) -> OperationConfirmation:
    operation = (
        ProductionOperation.objects.select_for_update(of=("self",))
        .select_related("work_center", "order")
        .get(pk=operation.pk)
    )
    order = ProductionOrder.objects.select_for_update().get(pk=operation.order_id)
    _active(order)
    pdp.require(ctx, f"{PO}.confirm", pdp.Resource.of(order))
    minutes = Decimal(minutes)
    if minutes <= 0:
        raise ValidationError({"minutes": ["Book a positive time."]})
    hours = minutes / MINUTES_PER_HOUR
    wc = operation.work_center
    costs = {
        k: (hours * rate).quantize(Q4, rounding=ROUND_HALF_UP)
        for k, rate in (
            ("labour_cost", wc.labour_rate),
            ("machine_cost", wc.machine_rate),
            ("overhead_cost", wc.overhead_rate),
        )
    }
    confirmation = OperationConfirmation.objects.create(
        operation=operation, minutes=minutes, quantity=quantity, operator=ctx.user, **costs
    )
    operation.actual_minutes += minutes
    operation.completed_quantity += Decimal(quantity)
    operation.save(update_fields=["actual_minutes", "completed_quantity"])
    for key, value in costs.items():
        setattr(order, key, getattr(order, key) + value)
    order.status = ProductionOrder.Status.IN_PROGRESS
    order.version += 1
    order.save()
    return confirmation


@transaction.atomic
def receive_output(
    ctx: ActorContext,
    order: ProductionOrder,
    *,
    quantity: Decimal,
    on: date,
    batch_number: str = "",
    serials: list[str] | None = None,
) -> ProductionOrder:
    """Consume materials for this quantity (WIP for manual, stores for backflush) and receive output at cost."""
    order = (
        ProductionOrder.objects.select_for_update(of=("self",))
        .select_related("item__category", "source_warehouse", "wip_warehouse", "output_warehouse")
        .get(pk=order.pk)
    )
    _active(order)
    pdp.require(ctx, f"{PO}.receive", pdp.Resource.of(order))
    quantity = Decimal(quantity)
    if quantity <= 0:
        raise ValidationError({"quantity": ["Receive a positive quantity."]})
    if order.produced_quantity + quantity > order.quantity * Decimal("1.05"):
        raise BusinessRuleViolation("Output exceeds the order quantity by more than 5%.", code="over_production")
    moves = []
    remaining_share = order.quantity - order.produced_quantity
    for material in order.materials.select_for_update(of=("self",)).select_related("item__category", "reservation"):
        if order.produced_quantity + quantity >= order.quantity:
            need = material.required_quantity - material.consumed_quantity  # final receipt consumes the rest
        else:
            need = (material.per_unit * quantity).quantize(Q6, rounding=ROUND_HALF_UP)
        if material.issue_method == BomComponent.IssueMethod.BACKFLUSH:
            moves.append(
                Move(
                    item=material.item,
                    warehouse=order.source_warehouse,
                    quantity=-need,
                    movement_type="backflush",
                    consume_reservation=material.reservation,
                    source_line_id=material.pk,
                )
            )
            material.issued_quantity += need
        else:
            in_wip = material.issued_quantity - material.consumed_quantity - material.returned_quantity
            if in_wip < need:
                raise BusinessRuleViolation(
                    f"Issue {need - in_wip:.3f} more {material.item.code} to the order before receiving output.",
                    code="materials_not_issued",
                    meta={"item_id": str(material.item_id), "missing": str(need - in_wip)},
                )
            moves.append(
                Move(
                    item=material.item,
                    warehouse=order.wip_warehouse,
                    quantity=-need,
                    movement_type="production_consumption",
                    source_line_id=material.pk,
                )
            )
        material.consumed_quantity += need
        material.save(update_fields=["issued_quantity", "consumed_quantity"])
    # Conversion cost absorbed in proportion to output (the final receipt absorbs whatever is left).
    total_conversion = order.labour_cost + order.machine_cost + order.overhead_cost
    unabsorbed = total_conversion - order.absorbed_conversion
    absorbed = unabsorbed if quantity >= remaining_share else (unabsorbed * quantity / remaining_share).quantize(Q4)
    labour_part = (
        ((order.labour_cost + order.machine_cost) / total_conversion * absorbed).quantize(Q4)
        if total_conversion
        else ZERO
    )
    extra = [
        Line(amount=-labour_part, key="labour_absorbed"),
        Line(amount=-(absorbed - labour_part), key="overhead_absorbed"),
    ]
    hold = order.item.inspection_required
    batch = get_or_create_batch(order.company_id, order.item, batch_number, manufactured_on=on)
    moves.append(
        Move(
            item=order.item,
            warehouse=order.output_warehouse,
            quantity=quantity,
            movement_type="production_receipt",
            batch=batch,
            serials=serials or [],
            stock_status=StockStatus.QUALITY_HOLD if hold else StockStatus.UNRESTRICTED,
            absorb_previous_issues=True,
            additional_cost=absorbed,
        )
    )
    txn = post_stock(
        ctx,
        company_id=order.company_id,
        posting_date=on,
        moves=moves,
        source_type=PO,
        source_id=order.pk,
        reference=order.number,
        narration=f"Output of {order.number}",
        extra_lines=extra,
    )
    output_value = moves[-1].value
    order.material_cost += output_value - absorbed
    order.absorbed_conversion += absorbed
    order.produced_quantity += quantity
    if order.produced_quantity >= order.quantity:
        order.status = ProductionOrder.Status.COMPLETED
    order.version += 1
    order.save()
    if hold:
        quality.create_inspection(
            ctx,
            company_id=order.company_id,
            stage="final",
            item=order.item,
            warehouse=order.output_warehouse,
            quantity=quantity,
            source_type=PO,
            source_id=order.pk,
            batch=batch,
            serials=serials or [],
            on=on,
        )
    publish_event(
        "manufacturing.output.received",
        aggregate_type=PO,
        aggregate_id=order.pk,
        company_id=order.company_id,
        payload={"quantity": str(quantity), "txn": str(txn.pk)},
    )
    return order


@transaction.atomic
def record_scrap(
    ctx: ActorContext, order: ProductionOrder, *, material: ProductionMaterial, quantity: Decimal, on: date, reason: str
) -> ProductionOrder:
    """Write off issued material that was spoiled in process (WIP -> scrap expense)."""
    order = ProductionOrder.objects.select_for_update(of=("self",)).select_related("wip_warehouse").get(pk=order.pk)
    _active(order)
    pdp.require(ctx, f"{PO}.confirm", pdp.Resource.of(order))
    material = (
        ProductionMaterial.objects.select_for_update(of=("self",))
        .select_related("item__category")
        .get(pk=material.pk, order=order)
    )
    quantity = Decimal(quantity)
    if material.issued_quantity - material.consumed_quantity - material.returned_quantity < quantity:
        raise BusinessRuleViolation(
            "You can only scrap material that was issued to the order.", code="scrap_exceeds_wip"
        )
    move = Move(
        item=material.item,
        warehouse=order.wip_warehouse,
        quantity=-quantity,
        movement_type="scrap",
        contra_key="scrap_expense",
        source_line_id=material.pk,
        allow_expired=True,
    )
    post_stock(
        ctx,
        company_id=order.company_id,
        posting_date=on,
        moves=[move],
        source_type=PO,
        source_id=order.pk,
        reference=order.number,
        narration=f"Scrap on {order.number}: {reason}"[:500],
    )
    material.consumed_quantity += quantity
    material.save(update_fields=["consumed_quantity"])
    order.scrap_cost += -move.value
    order.version += 1
    order.save()
    return order


@transaction.atomic
def cancel_order(ctx: ActorContext, order: ProductionOrder, *, reason: str) -> ProductionOrder:
    """Cancel an order nothing has happened on yet (no issue, confirmation, output or scrap); frees its
    reservations. Orders with activity are closed instead, which returns WIP and keeps the cost record."""
    order = ProductionOrder.objects.select_for_update(of=("self",)).get(pk=order.pk)
    if order.status not in (ProductionOrder.Status.DRAFT, ProductionOrder.Status.RELEASED):
        raise InvalidStateTransition("Only draft or released orders can be cancelled; close it instead.")
    pdp.require(ctx, f"{PO}.cancel", pdp.Resource.of(order))
    if not reason.strip():
        raise ValidationError({"reason": ["Give the reason for cancelling."]})
    materials = list(order.materials.select_for_update(of=("self",)).select_related("reservation"))
    if (
        order.produced_quantity
        or order.scrapped_quantity
        or any(m.issued_quantity for m in materials)
        or (OperationConfirmation.objects.filter(operation__order=order).exists())
    ):
        raise InvalidStateTransition("Work has been recorded on this order; close it instead.")
    for material in materials:
        if material.reservation is not None:
            release(ctx, material.reservation)
    order.status = ProductionOrder.Status.CANCELLED
    order.version += 1
    order.save(update_fields=["status", "version", "updated_at"])
    audit.record(
        f"{PO}.cancelled",
        ctx=ctx,
        resource_type=PO,
        resource_id=order.pk,
        company_id=order.company_id,
        summary=f"{order.number}: {reason.strip()}"[:500],
    )
    return order


@transaction.atomic
def close_order(ctx: ActorContext, order: ProductionOrder, *, on: date) -> ProductionOrder:
    """Return unused WIP to stores, release reservations, and freeze the cost record."""
    order = (
        ProductionOrder.objects.select_for_update(of=("self",))
        .select_related("source_warehouse", "wip_warehouse")
        .get(pk=order.pk)
    )
    if order.status not in (
        ProductionOrder.Status.COMPLETED,
        ProductionOrder.Status.IN_PROGRESS,
        ProductionOrder.Status.RELEASED,
    ):
        raise InvalidStateTransition("This order can't be closed.")
    pdp.require(ctx, f"{PO}.close", pdp.Resource.of(order))
    moves = []
    for material in order.materials.select_for_update(of=("self",)).select_related("item__category", "reservation"):
        leftover = material.issued_quantity - material.consumed_quantity - material.returned_quantity
        if leftover > 0:
            moves += [
                Move(
                    item=material.item,
                    warehouse=order.wip_warehouse,
                    quantity=-leftover,
                    movement_type="production_return",
                    source_line_id=material.pk,
                ),
                Move(
                    item=material.item,
                    warehouse=order.source_warehouse,
                    quantity=leftover,
                    movement_type="production_return_in",
                    value_from_previous=True,
                    source_line_id=material.pk,
                ),
            ]
            material.returned_quantity += leftover
            material.save(update_fields=["returned_quantity"])
        if material.reservation is not None:
            release(ctx, material.reservation)
    if moves:
        post_stock(
            ctx,
            company_id=order.company_id,
            posting_date=on,
            moves=moves,
            source_type=PO,
            source_id=order.pk,
            reference=order.number,
            narration=f"WIP returned on closing {order.number}",
        )
    unabsorbed = order.labour_cost + order.machine_cost + order.overhead_cost - order.absorbed_conversion
    if unabsorbed > 0 and order.produced_quantity == 0:
        raise BusinessRuleViolation(
            "Time was booked but nothing was produced. Cancel or receive output first.", code="unabsorbed_conversion"
        )
    order.status, order.closed_at = ProductionOrder.Status.CLOSED, timezone.now()
    order.version += 1
    order.save()
    audit.record(
        f"{PO}.closed",
        ctx=ctx,
        resource_type=PO,
        resource_id=order.pk,
        company_id=order.company_id,
        changes=costing(order),
    )
    return order


def costing(order: ProductionOrder) -> dict:
    conversion = order.labour_cost + order.machine_cost + order.overhead_cost
    total = order.material_cost + order.absorbed_conversion
    per_unit = (total / order.produced_quantity).quantize(Q4) if order.produced_quantity else ZERO
    standard = order.item.standard_cost
    return {
        "produced_quantity": str(order.produced_quantity),
        "material_cost": str(order.material_cost),
        "labour_cost": str(order.labour_cost),
        "machine_cost": str(order.machine_cost),
        "overhead_cost": str(order.overhead_cost),
        "conversion_cost": str(conversion),
        "absorbed_conversion": str(order.absorbed_conversion),
        "scrap_cost": str(order.scrap_cost),
        "total_cost": str(total),
        "unit_cost": str(per_unit),
        "standard_cost": str(standard),
        "variance_per_unit": str(per_unit - standard) if standard else None,
    }
