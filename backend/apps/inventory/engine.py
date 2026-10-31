"""Stock posting engine (ARCHITECTURE §5.1–5.2).

`post_stock` is the only way stock changes. In one transaction it:
1. locks the valuation rows of every (item, warehouse) touched, in a fixed order (no deadlocks);
2. checks availability under those locks (negative stock only where the warehouse allows it
   AND the user holds `inventory.stock.negative_override`), honouring reservations;
3. values each movement at moving weighted average cost (receipts at the given cost);
4. writes append-only ledger entries, updates balance and valuation caches, batches and serials;
5. posts the matching GL journal (inventory account by posting group / warehouse type vs. contra).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

from django.db import connection, transaction
from django.db.models import Sum
from django.utils import timezone

from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import BusinessRuleViolation
from apps.core.outbox import publish_event
from apps.finance.models import Account
from apps.finance.posting import Line, post_journal
from apps.masterdata.models import Item
from apps.organization.models import Warehouse
from apps.organization.services import ensure_period_open

from .models import (
    Batch,
    ItemValuation,
    Location,
    SerialNumber,
    StockBalance,
    StockLedgerEntry,
    StockLedgerSerial,
    StockReservation,
    StockStatus,
    StockTransaction,
)

Q4 = Decimal("0.0001")
Q6 = Decimal("0.000001")
ZERO = Decimal("0")


@dataclass
class Move:
    item: Item
    warehouse: Warehouse
    quantity: Decimal  # signed, in stock UoM
    movement_type: str
    stock_status: str = StockStatus.UNRESTRICTED
    location: Location | None = None
    batch: Batch | None = None
    serials: list[str] = field(default_factory=list)
    unit_cost: Decimal | None = None  # receipts; default = current average (or standard cost)
    value_from_previous: bool = False  # receipt leg of a transfer/status change: carries the issue value
    # Production output: value = all issues earlier in this posting (materials consumed) + additional_cost
    # (labour/overhead absorbed, credited through `extra_lines`).
    absorb_previous_issues: bool = False
    additional_cost: Decimal = Decimal("0")
    contra_key: str | None = None  # GL determination key of the counter-entry (None = balanced by other moves)
    contra_account: Account | None = None
    # Contra posted at a fixed amount instead of -value (e.g. GRNI cleared at the receipt price);
    # the difference goes to `variance_key` (e.g. purchase_price_variance).
    contra_amount: Decimal | None = None
    variance_key: str | None = None
    partner_id: UUID | None = None
    cost_center_id: UUID | None = None
    source_line_id: UUID | None = None
    consume_reservation: StockReservation | None = None
    allow_expired: bool = False
    # filled by the engine
    value: Decimal = ZERO
    entry: StockLedgerEntry | None = None


def _lock_valuations(company_id, moves: list[Move]) -> dict[tuple, ItemValuation]:
    keys = sorted({(str(m.item.pk), str(m.warehouse.pk)) for m in moves})
    locked = {}
    for item_id, wh_id in keys:
        ItemValuation.objects.get_or_create(company_id=company_id, item_id=item_id, warehouse_id=wh_id)
        locked[(item_id, wh_id)] = ItemValuation.objects.select_for_update().get(
            company_id=company_id, item_id=item_id, warehouse_id=wh_id
        )
    return locked


def _balance(company_id, m: Move) -> StockBalance:
    lookup = {
        "company_id": company_id,
        "item_id": m.item.pk,
        "warehouse_id": m.warehouse.pk,
        "location": m.location,
        "batch": m.batch,
        "stock_status": m.stock_status,
    }
    balance = StockBalance.objects.filter(**lookup).first()
    return balance or StockBalance(**lookup, quantity=ZERO)


def unrestricted_on_hand(company_id, item_id, warehouse_id) -> Decimal:
    return (
        StockBalance.objects.filter(
            company_id=company_id, item_id=item_id, warehouse_id=warehouse_id, stock_status=StockStatus.UNRESTRICTED
        ).aggregate(q=Sum("quantity"))["q"]
        or ZERO
    )


def _check_tracking(company_id, m: Move, posting_date: date) -> None:
    item = m.item
    if not item.is_stocked:
        raise BusinessRuleViolation(f"{item.code} isn't a stocked item.", code="item_not_stocked")
    if item.tracking == Item.Tracking.BATCH and m.batch is None:
        raise BusinessRuleViolation(f"{item.code} needs a batch number.", code="batch_required")
    if item.tracking != Item.Tracking.BATCH and m.batch is not None:
        raise BusinessRuleViolation(f"{item.code} isn't batch-tracked.", code="batch_not_tracked")
    if m.batch and m.batch.item_id != item.pk:
        raise BusinessRuleViolation("Batch belongs to another item.", code="batch_item_mismatch")
    if m.quantity < 0 and m.batch and m.batch.expires_on and m.batch.expires_on < posting_date and not m.allow_expired:
        raise BusinessRuleViolation(
            f"Batch {m.batch.batch_number} expired on {m.batch.expires_on}.", code="batch_expired"
        )
    if item.tracking == Item.Tracking.SERIAL:
        if m.quantity != m.quantity.to_integral_value() or len(set(m.serials)) != abs(int(m.quantity)):
            raise BusinessRuleViolation(
                f"{item.code} needs exactly one unique serial number per unit.", code="serials_required"
            )
    elif m.serials:
        raise BusinessRuleViolation(f"{item.code} isn't serial-tracked.", code="serials_not_tracked")
    if m.location and m.location.warehouse_id != m.warehouse.pk:
        raise BusinessRuleViolation("Location belongs to another warehouse.", code="location_mismatch")
    if m.warehouse.company_id != company_id:
        raise BusinessRuleViolation("Warehouse belongs to another company.", code="warehouse_company")


def _serials(company_id, m: Move, entry: StockLedgerEntry) -> None:
    links = []
    for code in m.serials:
        if m.quantity > 0:
            serial, created = SerialNumber.objects.select_for_update().get_or_create(
                company_id=company_id,
                item=m.item,
                serial=code,
                defaults={
                    "status": SerialNumber.Status.IN_STOCK,
                    "warehouse": m.warehouse,
                    "location": m.location,
                    "stock_status": m.stock_status,
                    "batch": m.batch,
                },
            )
            if not created:
                if serial.status == SerialNumber.Status.IN_STOCK:
                    raise BusinessRuleViolation(f"Serial {code} is already in stock.", code="serial_duplicate")
                serial.status, serial.warehouse, serial.location = SerialNumber.Status.IN_STOCK, m.warehouse, m.location
                serial.stock_status, serial.batch = m.stock_status, m.batch
                serial.save()
        else:
            serial = (
                SerialNumber.objects.select_for_update().filter(company_id=company_id, item=m.item, serial=code).first()
            )
            if (
                serial is None
                or serial.status != SerialNumber.Status.IN_STOCK
                or serial.warehouse_id != m.warehouse.pk
                or serial.stock_status != m.stock_status
            ):
                raise BusinessRuleViolation(f"Serial {code} isn't available here.", code="serial_not_available")
            serial.status = SerialNumber.Status.SCRAPPED if m.movement_type == "scrap" else SerialNumber.Status.ISSUED
            serial.save(update_fields=["status", "updated_at"])
        links.append(StockLedgerSerial(entry=entry, serial=serial))
    StockLedgerSerial.objects.bulk_create(links)


def post_stock(
    ctx: ActorContext,
    *,
    company_id,
    posting_date: date,
    moves: list[Move],
    source_type: str,
    source_id: UUID,
    reference: str = "",
    narration: str = "",
    extra_lines: list[Line] | None = None,
) -> StockTransaction:
    """`extra_lines` join the same journal (e.g. labour and overhead absorbed into finished goods)."""
    if not connection.in_atomic_block:
        raise RuntimeError("post_stock must run inside the business transaction")
    if not moves:
        raise BusinessRuleViolation("Nothing to post.", code="no_movements")
    ensure_period_open(company_id, posting_date, "inventory")
    for m in moves:
        m.quantity = Decimal(m.quantity).quantize(Q6)
        if m.quantity == 0:
            raise BusinessRuleViolation("Movement quantity can't be zero.", code="zero_quantity")
        _check_tracking(company_id, m, posting_date)

    valuations = _lock_valuations(company_id, moves)
    txn = StockTransaction.objects.create(
        company_id=company_id,
        posting_date=posting_date,
        source_type=source_type,
        source_id=source_id,
        reference=reference[:80],
        posted_by=ctx.user,
    )
    journal: list[Line] = []
    previous_value: Decimal | None = None
    issues_total = ZERO
    touched = set()

    for m in moves:
        val = valuations[(str(m.item.pk), str(m.warehouse.pk))]
        balance = _balance(company_id, m)
        if m.quantity < 0:
            needed = -m.quantity
            unrestricted = unrestricted_on_hand(company_id, m.item.pk, m.warehouse.pk)
            reserved_for_others = val.reserved_quantity
            if m.consume_reservation is not None:
                reserved_for_others -= min(m.consume_reservation.remaining, needed)
            short = balance.quantity < needed or (
                m.stock_status == StockStatus.UNRESTRICTED and unrestricted - reserved_for_others < needed
            )
            if short:
                allowed = m.warehouse.allow_negative_stock and (
                    ctx.is_system
                    or pdp.can(
                        ctx,
                        "inventory.stock.negative_override",
                        pdp.Resource.ref("inventory.stock", company_id=company_id, warehouse_id=m.warehouse.pk),
                    )
                )
                if not allowed:
                    available = max(min(balance.quantity, unrestricted - reserved_for_others), ZERO)
                    raise BusinessRuleViolation(
                        f"Not enough {m.item.code} in {m.warehouse.code}: need {needed.normalize()}, "
                        f"available {available.normalize()}.",
                        code="insufficient_stock",
                        meta={
                            "item_id": str(m.item.pk),
                            "warehouse_id": str(m.warehouse.pk),
                            "available": str(available),
                            "requested": str(needed),
                        },
                    )
            if val.quantity + m.quantity == 0:
                value = -val.value  # clears rounding residue so value is zero with quantity
            else:
                value = (m.quantity * val.avg_cost).quantize(Q4, rounding=ROUND_HALF_UP)
            unit_cost = val.avg_cost
            previous_value = value
            issues_total += value
            if m.consume_reservation is not None:
                res = StockReservation.objects.select_for_update().get(pk=m.consume_reservation.pk)
                take = min(res.remaining, needed)
                res.consumed_quantity += take
                if res.consumed_quantity == res.quantity:
                    res.status = StockReservation.Status.CONSUMED
                res.save(update_fields=["consumed_quantity", "status", "updated_at"])
                val.reserved_quantity -= take
        else:
            if m.absorb_previous_issues:
                value = (-issues_total + Decimal(m.additional_cost)).quantize(Q4)
                issues_total = ZERO
                unit_cost = (value / m.quantity).quantize(Q6, rounding=ROUND_HALF_UP)
            elif m.value_from_previous:
                if previous_value is None:
                    raise BusinessRuleViolation("Linked receipt without a preceding issue.", code="engine_misuse")
                value = -previous_value
                unit_cost = (value / m.quantity).quantize(Q6, rounding=ROUND_HALF_UP)
            else:
                unit_cost = m.unit_cost if m.unit_cost is not None else (val.avg_cost or m.item.standard_cost)
                unit_cost = Decimal(unit_cost).quantize(Q6)
                if unit_cost < 0:
                    raise BusinessRuleViolation("Unit cost can't be negative.", code="negative_cost")
                value = (m.quantity * unit_cost).quantize(Q4, rounding=ROUND_HALF_UP)
            previous_value = None

        val.quantity += m.quantity
        val.value += value
        if val.quantity > 0:
            val.avg_cost = (val.value / val.quantity).quantize(Q6, rounding=ROUND_HALF_UP)
        elif m.quantity > 0:
            val.avg_cost = unit_cost  # negative stock being refilled: keep the latest cost
        val.save()
        balance.quantity += m.quantity
        balance.save()
        m.value = value
        m.entry = StockLedgerEntry.objects.create(
            transaction=txn,
            company_id=company_id,
            warehouse=m.warehouse,
            location=m.location,
            item=m.item,
            batch=m.batch,
            movement_type=m.movement_type,
            stock_status=m.stock_status,
            quantity=m.quantity,
            unit_cost=unit_cost,
            value=value,
            balance_quantity_after=val.quantity,
            balance_value_after=val.value,
            posting_date=posting_date,
            source_type=source_type,
            source_id=source_id,
            source_line_id=m.source_line_id,
        )
        if m.serials:
            _serials(company_id, m, m.entry)
        touched.add((str(m.item.pk), str(m.warehouse.pk)))

        group, wh_type = m.item.category.posting_group, m.warehouse.warehouse_type
        journal.append(
            Line(
                amount=value,
                key="inventory",
                posting_group=group,
                warehouse_type=wh_type,
                item_id=m.item.pk,
                warehouse_id=m.warehouse.pk,
            )
        )
        if m.contra_key or m.contra_account:
            contra = -value if m.contra_amount is None else Decimal(m.contra_amount).quantize(Q4)
            journal.append(
                Line(
                    amount=contra,
                    key=m.contra_key,
                    account=m.contra_account,
                    posting_group=group,
                    warehouse_type=wh_type,
                    partner_id=m.partner_id,
                    cost_center_id=m.cost_center_id,
                    item_id=m.item.pk,
                )
            )
            variance = -(value + contra)
            if variance:
                if not m.variance_key:
                    raise BusinessRuleViolation(
                        "Contra amount differs from stock value without a variance account.", code="engine_misuse"
                    )
                journal.append(
                    Line(
                        amount=variance,
                        key=m.variance_key,
                        posting_group=group,
                        warehouse_type=wh_type,
                        item_id=m.item.pk,
                    )
                )

    journal.extend(extra_lines or [])
    entry = post_journal(
        ctx,
        company_id=company_id,
        entry_date=posting_date,
        lines=journal,
        narration=narration or f"{source_type} {reference}".strip(),
        source_module="inventory",
        source_type=source_type,
        source_id=source_id,
    )
    if entry is not None:
        txn.journal_entry = entry
        txn.save(update_fields=["journal_entry"])
    publish_event(
        "inventory.stock.posted",
        aggregate_type="inventory.stock_transaction",
        aggregate_id=txn.pk,
        company_id=company_id,
        payload={"source_type": source_type, "items": sorted(touched)},
    )
    return txn


# --- Reservations ------------------------------------------------------------------------------


@transaction.atomic
def reserve(
    ctx: ActorContext,
    *,
    company_id,
    item: Item,
    warehouse: Warehouse,
    quantity: Decimal,
    source_type: str,
    source_id: UUID,
    source_line_id: UUID | None = None,
) -> StockReservation:
    quantity = Decimal(quantity).quantize(Q6)
    if quantity <= 0:
        raise BusinessRuleViolation("Reserve a positive quantity.", code="invalid_quantity")
    val = _lock_valuations(
        company_id, [Move(item=item, warehouse=warehouse, quantity=quantity, movement_type="reservation")]
    )[(str(item.pk), str(warehouse.pk))]
    available = unrestricted_on_hand(company_id, item.pk, warehouse.pk) - val.reserved_quantity
    if available < quantity:
        raise BusinessRuleViolation(
            f"Only {max(available, ZERO).normalize()} {item.stock_uom.code} of {item.code} can be reserved in "
            f"{warehouse.code}.",
            code="insufficient_stock",
            meta={"available": str(max(available, ZERO))},
        )
    val.reserved_quantity += quantity
    val.save(update_fields=["reserved_quantity", "updated_at"])
    return StockReservation.objects.create(
        company_id=company_id,
        item=item,
        warehouse=warehouse,
        quantity=quantity,
        source_type=source_type,
        source_id=source_id,
        source_line_id=source_line_id,
        created_by=ctx.user,
        updated_by=ctx.user,
    )


@transaction.atomic
def release(ctx: ActorContext, reservation: StockReservation) -> StockReservation:
    reservation = StockReservation.objects.select_for_update().get(pk=reservation.pk)
    if reservation.status != StockReservation.Status.ACTIVE:
        return reservation
    val = _lock_valuations(
        reservation.company_id,
        [
            Move(
                item=reservation.item, warehouse=reservation.warehouse, quantity=Decimal(1), movement_type="reservation"
            )
        ],
    )
    val = val[(str(reservation.item_id), str(reservation.warehouse_id))]
    val.reserved_quantity -= reservation.remaining
    val.save(update_fields=["reserved_quantity", "updated_at"])
    reservation.status = StockReservation.Status.RELEASED
    reservation.updated_by = ctx.user
    reservation.save(update_fields=["status", "updated_by", "updated_at"])
    return reservation


def get_or_create_batch(
    company_id,
    item: Item,
    batch_number: str,
    *,
    expires_on=None,
    manufactured_on=None,
    supplier_batch: str = "",
    create: bool = True,
) -> Batch | None:
    if not batch_number:
        return None
    batch = Batch.objects.filter(company_id=company_id, item=item, batch_number=batch_number).first()
    if batch is None:
        if not create:
            raise BusinessRuleViolation(f"Batch {batch_number} doesn't exist for {item.code}.", code="batch_unknown")
        if expires_on is None and item.shelf_life_days and manufactured_on:
            from datetime import timedelta

            expires_on = manufactured_on + timedelta(days=item.shelf_life_days)
        batch = Batch.objects.create(
            company_id=company_id,
            item=item,
            batch_number=batch_number,
            expires_on=expires_on,
            manufactured_on=manufactured_on,
            supplier_batch=supplier_batch,
        )
    return batch


def now_date() -> date:
    return timezone.localdate()
