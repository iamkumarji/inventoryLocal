"""Material requirements planning (PRC-001). Produces suggestions; people turn them into requisitions or
production orders. Never posts anything by itself."""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from django.db import models, transaction
from django.db.models import Sum
from django.utils import timezone

from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.fields import QuantityField
from apps.core.models import CompanyScopedModel, UUIDModel

ZERO = Decimal("0")


class MrpRun(CompanyScopedModel):
    run_at = models.DateTimeField(auto_now_add=True)
    horizon_days = models.PositiveIntegerField(default=30)

    authz_resource_type = "procurement.mrp"

    class Meta:
        db_table = "mrp_runs"


class MrpSuggestion(UUIDModel):
    class Action(models.TextChoices):
        PURCHASE = "purchase"
        PRODUCE = "produce"

    run = models.ForeignKey(MrpRun, on_delete=models.CASCADE, related_name="suggestions")
    item = models.ForeignKey("masterdata.Item", on_delete=models.PROTECT, related_name="+")
    action = models.CharField(max_length=10, choices=Action.choices)
    on_hand = QuantityField()
    open_supply = QuantityField()
    demand = QuantityField()
    reorder_level = QuantityField()
    suggested_quantity = QuantityField()
    status = models.CharField(max_length=10, default="open")  # open | converted | dismissed

    class Meta:
        db_table = "mrp_suggestions"


def _supply_and_demand(company_id) -> tuple[dict, dict, dict]:
    from apps.inventory.models import StockBalance
    from apps.manufacturing.models import ProductionMaterial, ProductionOrder
    from apps.procurement.models import PurchaseOrderLine
    from apps.sales.models import SalesOrderLine

    on_hand = defaultdict(Decimal)
    for row in (
        StockBalance.objects.filter(
            company_id=company_id, stock_status__in=["unrestricted", "quality_hold", "in_transit"]
        )
        .values("item_id")
        .annotate(q=Sum("quantity"))
    ):
        on_hand[row["item_id"]] += row["q"]
    supply = defaultdict(Decimal)
    from apps.masterdata.services import to_stock_qty

    for line in PurchaseOrderLine.objects.filter(order__company_id=company_id, order__status="approved").select_related(
        "item", "uom"
    ):
        open_qty = line.quantity - line.received_quantity + line.returned_quantity
        if open_qty > 0:
            supply[line.item_id] += to_stock_qty(line.item, open_qty, line.uom)
    for order in ProductionOrder.objects.filter(company_id=company_id, status__in=["draft", "released", "in_progress"]):
        supply[order.item_id] += max(order.quantity - order.produced_quantity, ZERO)
    demand = defaultdict(Decimal)
    for line in SalesOrderLine.objects.filter(order__company_id=company_id, order__status="approved"):
        demand[line.item_id] += max(line.stock_quantity - line.delivered_quantity, ZERO)
    for m in ProductionMaterial.objects.filter(
        order__company_id=company_id, order__status__in=["released", "in_progress"]
    ):
        # Reserved/issued material is already out of free stock; count only what still has to be found.
        demand[m.item_id] += max(m.required_quantity - m.issued_quantity, ZERO)
    return on_hand, supply, demand


@transaction.atomic
def run_mrp(ctx: ActorContext, company, horizon_days: int = 30) -> MrpRun:
    from apps.manufacturing.services import explode, flatten
    from apps.masterdata.models import Item, ItemWarehousePolicy

    pdp.require(ctx, "procurement.mrp.create", pdp.Resource.ref("procurement.mrp", company_id=company.pk))
    on_hand, supply, demand = _supply_and_demand(company.pk)
    policies = {
        row["item_id"]: row
        for row in ItemWarehousePolicy.objects.filter(company=company)
        .values("item_id")
        .annotate(level=Sum("reorder_level"), reorder_qty=Sum("reorder_quantity"), max_qty=Sum("max_quantity"))
    }
    run = MrpRun.objects.create(company=company, horizon_days=horizon_days, created_by=ctx.user, updated_by=ctx.user)
    pending = set(demand) | set(policies)
    processed, suggestions = set(), []
    while pending:  # production suggestions add component demand, so iterate until stable
        item_id = pending.pop()
        if item_id in processed:
            continue
        processed.add(item_id)
        item = Item.objects.get(pk=item_id)
        if not item.is_stocked:
            continue
        policy = policies.get(item_id, {})
        level = policy.get("level") or ZERO
        net = on_hand[item_id] + supply[item_id] - demand[item_id]
        if net >= level:
            continue
        quantity = max(level - net, policy.get("reorder_qty") or ZERO)
        if policy.get("max_qty"):
            quantity = min(max(quantity, level - net), policy["max_qty"] - net)
        action = MrpSuggestion.Action.PRODUCE if item.is_manufactured else MrpSuggestion.Action.PURCHASE
        suggestions.append(
            MrpSuggestion(
                run=run,
                item=item,
                action=action,
                on_hand=on_hand[item_id],
                open_supply=supply[item_id],
                demand=demand[item_id],
                reorder_level=level,
                suggested_quantity=quantity,
            )
        )
        if action == MrpSuggestion.Action.PRODUCE:
            for comp_id, qty in flatten(explode(item, quantity, timezone.localdate())).items():
                from uuid import UUID

                comp_uuid = UUID(comp_id)
                demand[comp_uuid] += qty
                processed.discard(comp_uuid)
                pending.add(comp_uuid)
    MrpSuggestion.objects.bulk_create(suggestions)
    return run
