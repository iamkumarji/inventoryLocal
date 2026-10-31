"""Read models for inventory: on-hand, availability, valuation and ageing (always from the ledger/caches)."""

from datetime import date
from decimal import Decimal

from django.db.models import Sum

from .models import ItemValuation, StockBalance, StockLedgerEntry, StockStatus

ZERO = Decimal("0")
AGE_BUCKETS = [(30, "0–30 days"), (60, "31–60 days"), (90, "61–90 days"), (180, "91–180 days"), (None, "Over 180 days")]


def item_has_history(item) -> bool:
    return StockLedgerEntry.objects.filter(item=item).exists()


def availability(company_id, item_id, warehouse_id) -> dict:
    val = ItemValuation.objects.filter(company_id=company_id, item_id=item_id, warehouse_id=warehouse_id).first()
    by_status = dict(
        StockBalance.objects.filter(company_id=company_id, item_id=item_id, warehouse_id=warehouse_id)
        .values_list("stock_status")
        .annotate(q=Sum("quantity"))
    )
    unrestricted = by_status.get(StockStatus.UNRESTRICTED, ZERO)
    reserved = val.reserved_quantity if val else ZERO
    return {
        "on_hand": sum(by_status.values(), ZERO),
        "unrestricted": unrestricted,
        "quality_hold": by_status.get(StockStatus.QUALITY_HOLD, ZERO),
        "blocked": by_status.get(StockStatus.BLOCKED, ZERO),
        "in_transit": by_status.get(StockStatus.IN_TRANSIT, ZERO),
        "reserved": reserved,
        "available": unrestricted - reserved,
        "avg_cost": val.avg_cost if val else ZERO,
        "value": val.value if val else ZERO,
    }


def ageing(company_id, warehouse_ids, as_of: date) -> list[dict]:
    """Allocate on-hand quantity to the most recent receipts (FIFO consumption assumption)."""
    rows = []
    valuations = ItemValuation.objects.filter(
        company_id=company_id, warehouse_id__in=warehouse_ids, quantity__gt=0
    ).select_related("item", "warehouse")
    for val in valuations:
        remaining = val.quantity
        buckets = {label: ZERO for _, label in AGE_BUCKETS}
        receipts = (
            StockLedgerEntry.objects.filter(
                company_id=company_id,
                item_id=val.item_id,
                warehouse_id=val.warehouse_id,
                quantity__gt=0,
                posting_date__lte=as_of,
            )
            .exclude(movement_type__in=["transfer_in", "transfer_receive", "status_in"])
            .order_by("-posting_date", "-id")
            .values_list("posting_date", "quantity")
        )
        for posted, qty in receipts:
            if remaining <= 0:
                break
            take = min(qty, remaining)
            age = (as_of - posted).days
            label = next(lbl for limit, lbl in AGE_BUCKETS if limit is None or age <= limit)
            buckets[label] += take
            remaining -= take
        if remaining > 0:  # stock older than recorded receipts (e.g. transfers in): oldest bucket
            buckets[AGE_BUCKETS[-1][1]] += remaining
        rows.append(
            {
                "item_id": str(val.item_id),
                "item_code": val.item.code,
                "item_name": val.item.name,
                "warehouse_id": str(val.warehouse_id),
                "warehouse_code": val.warehouse.code,
                "quantity": val.quantity,
                "value": val.value,
                "buckets": buckets,
            }
        )
    return rows
