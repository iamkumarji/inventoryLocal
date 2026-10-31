"""Inventory documents: adjustments, transfers and counts. All stock changes go through the engine."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from django.db import transaction
from rest_framework.exceptions import ValidationError

from apps.approvals import registry
from apps.approvals import services as approvals
from apps.approvals.models import ApprovalRequest
from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition, VersionConflict
from apps.masterdata.models import Item
from apps.organization.services import allocate_number

from .engine import Move, get_or_create_batch, post_stock
from .models import (
    Batch,
    DocStatus,
    ItemValuation,
    StockAdjustment,
    StockAdjustmentLine,
    StockBalance,
    StockCount,
    StockCountLine,
    StockStatus,
    StockTransfer,
    StockTransferLine,
)

ADJUSTMENT = "inventory.stock_adjustment"


def _check_version(doc, expected):
    if expected is not None and doc.version != expected:
        raise VersionConflict()


def _require_status(doc, *allowed):
    if doc.status not in allowed:
        raise InvalidStateTransition(f"Not allowed while the document is {doc.status}.")


# --- Stock adjustments -------------------------------------------------------------------------


@transaction.atomic
def create_adjustment(
    ctx: ActorContext, *, company, warehouse, posting_date: date, reason: str, notes: str = "", lines: list[dict]
) -> StockAdjustment:
    pdp.require(
        ctx, f"{ADJUSTMENT}.create", pdp.Resource.ref(ADJUSTMENT, company_id=company.pk, warehouse_id=warehouse.pk)
    )
    if warehouse.company_id != company.pk:
        raise ValidationError({"warehouse": ["Warehouse belongs to another company."]})
    if not lines:
        raise ValidationError({"lines": ["Add at least one line."]})
    adjustment = StockAdjustment.objects.create(
        company=company,
        warehouse=warehouse,
        posting_date=posting_date,
        reason=reason,
        notes=notes,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for line in lines:
        if Decimal(line["quantity"]) == 0:
            raise ValidationError({"lines": ["Quantities can't be zero."]})
        StockAdjustmentLine.objects.create(adjustment=adjustment, **line)
    audit.record(
        f"{ADJUSTMENT}.created",
        ctx=ctx,
        resource_type=ADJUSTMENT,
        resource_id=adjustment.pk,
        company_id=company.pk,
        summary=f"{len(lines)} line(s), {reason}",
    )
    return adjustment


def _adjustment_value(adjustment: StockAdjustment) -> Decimal:
    total = Decimal("0")
    for line in adjustment.lines.select_related("item"):
        val = ItemValuation.objects.filter(
            company_id=adjustment.company_id, item=line.item, warehouse_id=adjustment.warehouse_id
        ).first()
        cost = (
            line.unit_cost
            if (line.quantity > 0 and line.unit_cost is not None)
            else (val.avg_cost if val and val.avg_cost else line.item.standard_cost)
        )
        total += abs(line.quantity) * cost
    return total.quantize(Decimal("0.01"))


@transaction.atomic
def cancel_adjustment(ctx: ActorContext, adjustment: StockAdjustment, *, reason: str, expected_version=None):
    """Drafts and rejected adjustments can be withdrawn; nothing was posted, so nothing is reversed."""
    with transaction.atomic():
        adjustment = StockAdjustment.objects.select_for_update().get(pk=adjustment.pk)
        _check_version(adjustment, expected_version)
        _require_status(adjustment, DocStatus.DRAFT, DocStatus.REJECTED)
        pdp.require(ctx, f"{ADJUSTMENT}.update", pdp.Resource.of(adjustment))
        if not reason.strip():
            raise ValidationError({"reason": ["Give the reason for cancelling."]})
        adjustment.status = DocStatus.CANCELLED
        adjustment.version += 1
        adjustment.save()
        audit.record(
            f"{ADJUSTMENT}.cancelled",
            ctx=ctx,
            resource_type=ADJUSTMENT,
            resource_id=adjustment.pk,
            company_id=adjustment.company_id,
            summary=reason[:500],
        )
    return adjustment


@transaction.atomic
def submit_adjustment(ctx: ActorContext, adjustment: StockAdjustment, expected_version=None) -> StockAdjustment:
    adjustment = StockAdjustment.objects.select_for_update().get(pk=adjustment.pk)
    _check_version(adjustment, expected_version)
    _require_status(adjustment, DocStatus.DRAFT, DocStatus.REJECTED)
    pdp.require(ctx, f"{ADJUSTMENT}.update", pdp.Resource.of(adjustment))
    adjustment.amount = _adjustment_value(adjustment)
    adjustment.status, adjustment.submitted_by = DocStatus.SUBMITTED, ctx.user
    adjustment.version += 1
    adjustment.save()
    if approvals.resolve_matrix(ctx.user.organization_id, adjustment.company_id, ADJUSTMENT):
        approvals.submit(
            ctx,
            document_type=ADJUSTMENT,
            document_id=adjustment.pk,
            company_id=adjustment.company_id,
            title=f"Stock adjustment, {adjustment.get_reason_display().lower()}",
            amount=adjustment.amount,
            currency=adjustment.currency,
            summary={"warehouse": adjustment.warehouse.code, "lines": adjustment.lines.count()},
            scope={"warehouse_id": adjustment.warehouse_id, "branch_id": adjustment.warehouse.branch_id},
        )
    audit.record(
        f"{ADJUSTMENT}.submitted",
        ctx=ctx,
        resource_type=ADJUSTMENT,
        resource_id=adjustment.pk,
        company_id=adjustment.company_id,
        changes={"amount": str(adjustment.amount)},
    )
    return adjustment


@transaction.atomic
def approve_adjustment_directly(
    ctx: ActorContext, adjustment: StockAdjustment, expected_version=None
) -> StockAdjustment:
    """For companies without an approval route: one approver, subject to limits and self-approval rules."""
    adjustment = StockAdjustment.objects.select_for_update().get(pk=adjustment.pk)
    _check_version(adjustment, expected_version)
    _require_status(adjustment, DocStatus.SUBMITTED)
    if ApprovalRequest.objects.filter(
        document_type=ADJUSTMENT, document_id=adjustment.pk, status=ApprovalRequest.Status.PENDING
    ).exists():
        raise BusinessRuleViolation(
            "This adjustment follows an approval route. Decide it in Approvals.", code="approval_route_active"
        )
    pdp.require(ctx, f"{ADJUSTMENT}.approve", pdp.Resource.of(adjustment))
    adjustment.status, adjustment.approved_by = DocStatus.APPROVED, ctx.user
    adjustment.version += 1
    adjustment.save()
    audit.record(
        f"{ADJUSTMENT}.approved",
        ctx=ctx,
        resource_type=ADJUSTMENT,
        resource_id=adjustment.pk,
        company_id=adjustment.company_id,
    )
    return adjustment


def _on_adjustment_decided(approved: bool):
    def callback(request: ApprovalRequest, ctx: ActorContext) -> None:
        adjustment = StockAdjustment.objects.select_for_update().get(pk=request.document_id)
        adjustment.status = DocStatus.APPROVED if approved else DocStatus.REJECTED
        adjustment.approved_by = ctx.user if approved else None
        adjustment.version += 1
        adjustment.save()

    return callback


def _on_adjustment_withdrawn(request: ApprovalRequest, ctx: ActorContext) -> None:
    StockAdjustment.objects.filter(pk=request.document_id).update(status=DocStatus.DRAFT)


registry.register(
    registry.DocumentType(
        code=ADJUSTMENT,
        label="Stock adjustment",
        on_approved=_on_adjustment_decided(True),
        on_rejected=_on_adjustment_decided(False),
        on_withdrawn=_on_adjustment_withdrawn,
        link=lambda r: f"/inventory/adjustments/{r.document_id}",
    )
)


@transaction.atomic
def post_adjustment(ctx: ActorContext, adjustment: StockAdjustment, expected_version=None) -> StockAdjustment:
    adjustment = StockAdjustment.objects.select_for_update().get(pk=adjustment.pk)
    _check_version(adjustment, expected_version)
    _require_status(adjustment, DocStatus.APPROVED)
    pdp.require(ctx, f"{ADJUSTMENT}.post", pdp.Resource.of(adjustment))
    moves = []
    for line in adjustment.lines.select_related("item__category", "item__stock_uom", "location"):
        batch = get_or_create_batch(
            adjustment.company_id, line.item, line.batch_number, expires_on=line.expires_on, create=line.quantity > 0
        )
        moves.append(
            Move(
                item=line.item,
                warehouse=adjustment.warehouse,
                quantity=line.quantity,
                movement_type="adjustment_in" if line.quantity > 0 else "adjustment_out",
                location=line.location,
                batch=batch,
                serials=list(line.serials),
                unit_cost=line.unit_cost,
                contra_key="inventory_adjustment",
                source_line_id=line.pk,
                allow_expired=adjustment.reason == StockAdjustment.Reason.EXPIRY,
            )
        )
    adjustment.number = allocate_number(adjustment.company_id, "ADJ", adjustment.posting_date)
    adjustment.stock_transaction = post_stock(
        ctx,
        company_id=adjustment.company_id,
        posting_date=adjustment.posting_date,
        moves=moves,
        source_type=ADJUSTMENT,
        source_id=adjustment.pk,
        reference=adjustment.number,
        narration=f"Stock adjustment {adjustment.number} ({adjustment.reason})",
    )
    adjustment.status = DocStatus.POSTED
    adjustment.version += 1
    adjustment.save()
    audit.record(
        f"{ADJUSTMENT}.posted",
        ctx=ctx,
        resource_type=ADJUSTMENT,
        resource_id=adjustment.pk,
        company_id=adjustment.company_id,
        summary=adjustment.number,
    )
    return adjustment


# --- Transfers ----------------------------------------------------------------------------------

TRANSFER = "inventory.stock_transfer"


@transaction.atomic
def create_transfer(
    ctx: ActorContext, *, company, from_warehouse, to_warehouse, notes: str = "", lines: list[dict]
) -> StockTransfer:
    pdp.require(
        ctx, f"{TRANSFER}.create", pdp.Resource.ref(TRANSFER, company_id=company.pk, warehouse_id=from_warehouse.pk)
    )
    if from_warehouse.pk == to_warehouse.pk:
        raise ValidationError({"to_warehouse": ["Choose a different destination."]})
    if {from_warehouse.company_id, to_warehouse.company_id} != {company.pk}:
        raise ValidationError({"to_warehouse": ["Transfers between companies are invoiced, not transferred."]})
    transfer = StockTransfer.objects.create(
        company=company,
        from_warehouse=from_warehouse,
        to_warehouse=to_warehouse,
        notes=notes,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for line in lines:
        StockTransferLine.objects.create(transfer=transfer, **line)
    return transfer


@transaction.atomic
def dispatch_transfer(ctx: ActorContext, transfer: StockTransfer, *, on: date, expected_version=None) -> StockTransfer:
    transfer = (
        StockTransfer.objects.select_for_update(of=("self",))
        .select_related("from_warehouse", "to_warehouse")
        .get(pk=transfer.pk)
    )
    _check_version(transfer, expected_version)
    _require_status(transfer, StockTransfer.Status.DRAFT)
    pdp.require(ctx, f"{TRANSFER}.dispatch", pdp.Resource.of(transfer))
    moves = []
    for line in transfer.lines.select_related("item__category"):
        moves += [
            Move(
                item=line.item,
                warehouse=transfer.from_warehouse,
                quantity=-line.quantity,
                movement_type="transfer_out",
                location=line.from_location,
                batch=line.batch,
                serials=list(line.serials),
                source_line_id=line.pk,
            ),
            Move(
                item=line.item,
                warehouse=transfer.to_warehouse,
                quantity=line.quantity,
                movement_type="transfer_in_transit",
                stock_status=StockStatus.IN_TRANSIT,
                batch=line.batch,
                serials=list(line.serials),
                value_from_previous=True,
                source_line_id=line.pk,
            ),
        ]
    transfer.number = allocate_number(transfer.company_id, "TRF", on)
    post_stock(
        ctx,
        company_id=transfer.company_id,
        posting_date=on,
        moves=moves,
        source_type=TRANSFER,
        source_id=transfer.pk,
        reference=transfer.number,
        narration=f"Transfer {transfer.number} dispatched",
    )
    transfer.status, transfer.dispatched_on, transfer.dispatched_by = StockTransfer.Status.DISPATCHED, on, ctx.user
    transfer.version += 1
    transfer.save()
    return transfer


@transaction.atomic
def receive_transfer(ctx: ActorContext, transfer: StockTransfer, *, on: date, expected_version=None) -> StockTransfer:
    transfer = StockTransfer.objects.select_for_update(of=("self",)).select_related("to_warehouse").get(pk=transfer.pk)
    _check_version(transfer, expected_version)
    _require_status(transfer, StockTransfer.Status.DISPATCHED)
    pdp.require(
        ctx,
        f"{TRANSFER}.receive",
        pdp.Resource.ref(TRANSFER, company_id=transfer.company_id, warehouse_id=transfer.to_warehouse_id),
    )
    if on < transfer.dispatched_on:
        raise ValidationError({"on": ["Receipt can't be before dispatch."]})
    moves = []
    for line in transfer.lines.select_related("item__category"):
        moves += [
            Move(
                item=line.item,
                warehouse=transfer.to_warehouse,
                quantity=-line.quantity,
                movement_type="transfer_receive",
                stock_status=StockStatus.IN_TRANSIT,
                batch=line.batch,
                serials=list(line.serials),
                source_line_id=line.pk,
                allow_expired=True,
            ),
            Move(
                item=line.item,
                warehouse=transfer.to_warehouse,
                quantity=line.quantity,
                movement_type="transfer_in",
                location=line.to_location,
                batch=line.batch,
                serials=list(line.serials),
                value_from_previous=True,
                source_line_id=line.pk,
            ),
        ]
    post_stock(
        ctx,
        company_id=transfer.company_id,
        posting_date=on,
        moves=moves,
        source_type=TRANSFER,
        source_id=transfer.pk,
        reference=transfer.number,
        narration=f"Transfer {transfer.number} received",
    )
    transfer.status, transfer.received_on, transfer.received_by = StockTransfer.Status.RECEIVED, on, ctx.user
    transfer.version += 1
    transfer.save()
    return transfer


# --- Stock counts --------------------------------------------------------------------------------

COUNT = "inventory.stock_count"


@transaction.atomic
def start_count(
    ctx: ActorContext, *, company, warehouse, count_date: date, blind: bool = True, item_ids: list | None = None
) -> StockCount:
    pdp.require(ctx, f"{COUNT}.create", pdp.Resource.ref(COUNT, company_id=company.pk, warehouse_id=warehouse.pk))
    count = StockCount.objects.create(
        company=company,
        warehouse=warehouse,
        count_date=count_date,
        blind=blind,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    count.number = allocate_number(company.pk, "CNT", count_date)
    count.save(update_fields=["number"])
    balances = StockBalance.objects.filter(
        company=company, warehouse=warehouse, stock_status=StockStatus.UNRESTRICTED
    ).exclude(quantity=0)
    if item_ids:
        balances = balances.filter(item_id__in=item_ids)
    lines = [
        StockCountLine(
            count=count, item_id=b.item_id, location_id=b.location_id, batch_id=b.batch_id, system_quantity=b.quantity
        )
        for b in balances.select_related("item")
        if b.item.tracking != Item.Tracking.SERIAL
    ]
    StockCountLine.objects.bulk_create(lines)
    audit.record(
        f"{COUNT}.started",
        ctx=ctx,
        resource_type=COUNT,
        resource_id=count.pk,
        company_id=company.pk,
        summary=f"{count.number}: {len(lines)} lines frozen",
    )
    return count


@transaction.atomic
def record_counts(ctx: ActorContext, count: StockCount, entries: list[dict]) -> StockCount:
    count = StockCount.objects.select_for_update().get(pk=count.pk)
    _require_status(count, StockCount.Status.COUNTING)
    pdp.require(ctx, f"{COUNT}.update", pdp.Resource.of(count))
    for entry in entries:
        qty = Decimal(entry["counted_quantity"])
        if qty < 0:
            raise ValidationError({"counted_quantity": ["Counts can't be negative."]})
        if entry.get("line_id"):
            line = count.lines.get(pk=entry["line_id"])
        else:  # found stock that wasn't in the system snapshot
            item = Item.objects.get(pk=entry["item_id"], organization_id=count.company.organization_id)
            if item.tracking == Item.Tracking.SERIAL:
                raise ValidationError({"item_id": ["Serial-tracked items are counted by serial, not here."]})
            batch = (
                Batch.objects.filter(
                    company_id=count.company_id, item=item, batch_number=entry.get("batch_number", "")
                ).first()
                if entry.get("batch_number")
                else None
            )
            line = StockCountLine.objects.create(
                count=count, item=item, location_id=entry.get("location_id"), batch=batch, system_quantity=Decimal("0")
            )
        line.counted_quantity, line.counted_by = qty, ctx.user
        line.save(update_fields=["counted_quantity", "counted_by"])
    return count


@transaction.atomic
def post_count(ctx: ActorContext, count: StockCount, expected_version=None) -> StockCount:
    count = StockCount.objects.select_for_update(of=("self",)).select_related("warehouse").get(pk=count.pk)
    _check_version(count, expected_version)
    _require_status(count, StockCount.Status.COUNTING, StockCount.Status.SUBMITTED)
    pdp.require(ctx, f"{COUNT}.approve", pdp.Resource.of(count))
    lines = list(count.lines.select_related("item__category", "location", "batch"))
    if any(line.counted_quantity is None for line in lines):
        raise BusinessRuleViolation("Every line needs a count before posting.", code="count_incomplete")
    if any(line.counted_by_id == ctx.user_id for line in lines):
        # Explained to the caller (403 with code "maker_checker"): they can see the count and know they counted it.
        raise AuthorizationDenied(reason="maker_checker")
    moves = [
        Move(
            item=line.item,
            warehouse=count.warehouse,
            quantity=line.counted_quantity - line.system_quantity,
            movement_type="count_gain" if line.counted_quantity > line.system_quantity else "count_loss",
            location=line.location,
            batch=line.batch,
            contra_key="stock_count_variance",
            source_line_id=line.pk,
            allow_expired=True,
        )
        for line in lines
        if line.counted_quantity != line.system_quantity
    ]
    if moves:
        count.stock_transaction = post_stock(
            ctx,
            company_id=count.company_id,
            posting_date=count.count_date,
            moves=moves,
            source_type=COUNT,
            source_id=count.pk,
            reference=count.number,
            narration=f"Stock count {count.number} variances",
        )
    count.status, count.approved_by = StockCount.Status.POSTED, ctx.user
    count.version += 1
    count.save()
    audit.record(
        f"{COUNT}.posted",
        ctx=ctx,
        resource_type=COUNT,
        resource_id=count.pk,
        company_id=count.company_id,
        summary=f"{count.number}: {len(moves)} variance line(s)",
    )
    return count
