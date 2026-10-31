"""Exportable reports (ANL-002/003). Each declares the export permission it needs and produces rows
from the source module's own report functions, narrowed to what the requester may see."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from rest_framework.exceptions import ValidationError

from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.finance import gst, reports, subledger
from apps.inventory import selectors
from apps.inventory.models import ItemValuation, StockLedgerEntry


@dataclass(frozen=True)
class ReportType:
    code: str
    label: str
    permission: str  # export permission, evaluated at company level or per row (scoped)
    company_level: bool
    params: tuple[str, ...]  # required parameters: date_from/date_to or as_of
    rows: Callable[[ActorContext, object, dict], list[dict]]


def _dates(params: dict, *names: str) -> list[date]:
    try:
        values = [date.fromisoformat(str(params[n])) for n in names]
    except (KeyError, ValueError) as exc:
        raise ValidationError({"params": [f"Provide {', '.join(names)} as YYYY-MM-DD."]}) from exc
    if len(values) == 2 and values[0] > values[1]:
        raise ValidationError({"params": ["date_from must not be after date_to."]})
    return values


def _trial_balance(ctx, company_id, params):
    return reports.trial_balance(company_id, *_dates(params, "date_from", "date_to"))["rows"]


def _ageing(kind):
    def rows(ctx, company_id, params):
        return subledger.ageing(company_id, kind, *_dates(params, "as_of"))

    return rows


def _gstr1_b2b(ctx, company_id, params):
    return gst.gstr1(company_id, *_dates(params, "date_from", "date_to"))["b2b"]


def _gstr1_hsn(ctx, company_id, params):
    return gst.gstr1(company_id, *_dates(params, "date_from", "date_to"))["hsn_summary"]


def _stock_valuation(ctx, company_id, params):
    (as_of,) = _dates(params, "as_of")
    vals = pdp.filter_queryset(
        ctx, "inventory.stock_balance.export", ItemValuation.objects.filter(company_id=company_id)
    )
    if as_of != date.today():
        # Historical valuation comes from the ledger; the valuation table only holds the present.
        entries = StockLedgerEntry.objects.filter(
            company_id=company_id, posting_date__lte=as_of, warehouse_id__in=vals.values("warehouse_id")
        )
        from django.db.models import Sum

        return [
            {
                "item_code": r["item__code"],
                "item": r["item__name"],
                "warehouse": r["warehouse__code"],
                "quantity": r["q"],
                "value": r["v"],
            }
            for r in entries.values("item__code", "item__name", "warehouse__code")
            .annotate(q=Sum("quantity"), v=Sum("value"))
            .order_by("warehouse__code", "item__code")
            if r["q"] or r["v"]
        ]
    return [
        {
            "item_code": v.item.code,
            "item": v.item.name,
            "warehouse": v.warehouse.code,
            "quantity": v.quantity,
            "value": v.value,
            "avg_cost": v.avg_cost,
        }
        for v in vals.select_related("item", "warehouse").order_by("warehouse__code", "item__code")
        if v.quantity or v.value
    ]


def _stock_ageing(ctx, company_id, params):
    (as_of,) = _dates(params, "as_of")
    vals = pdp.filter_queryset(
        ctx, "inventory.stock_balance.export", ItemValuation.objects.filter(company_id=company_id)
    )
    return selectors.ageing(company_id, set(vals.values_list("warehouse_id", flat=True)), as_of)


def _stock_ledger(ctx, company_id, params):
    d1, d2 = _dates(params, "date_from", "date_to")
    entries = pdp.filter_queryset(
        ctx,
        "inventory.stock_ledger.export",
        StockLedgerEntry.objects.filter(company_id=company_id, posting_date__gte=d1, posting_date__lte=d2),
    ).select_related("item", "warehouse")
    return [
        {
            "date": e.posting_date,
            "item_code": e.item.code,
            "warehouse": e.warehouse.code,
            "movement": e.movement_type,
            "status": e.stock_status,
            "quantity": e.quantity,
            "unit_cost": e.unit_cost,
            "value": e.value,
            "balance_quantity": e.balance_quantity_after,
            "source": e.source_type,
        }
        for e in entries.order_by("posting_date", "id")[:200_000]
    ]


REPORTS = {
    r.code: r
    for r in (
        ReportType(
            "trial_balance", "Trial balance", "finance.report.export", True, ("date_from", "date_to"), _trial_balance
        ),
        ReportType(
            "receivables_ageing",
            "Receivables ageing",
            "finance.open_item.export",
            True,
            ("as_of",),
            _ageing("receivable"),
        ),
        ReportType(
            "payables_ageing", "Payables ageing", "finance.open_item.export", True, ("as_of",), _ageing("payable")
        ),
        ReportType(
            "gstr1_b2b", "GSTR-1 B2B invoices", "finance.gst.export", True, ("date_from", "date_to"), _gstr1_b2b
        ),
        ReportType("gstr1_hsn", "GSTR-1 HSN summary", "finance.gst.export", True, ("date_from", "date_to"), _gstr1_hsn),
        ReportType(
            "stock_valuation", "Stock valuation", "inventory.stock_balance.export", False, ("as_of",), _stock_valuation
        ),
        ReportType("stock_ageing", "Stock ageing", "inventory.stock_balance.export", False, ("as_of",), _stock_ageing),
        ReportType(
            "stock_ledger",
            "Stock ledger",
            "inventory.stock_ledger.export",
            False,
            ("date_from", "date_to"),
            _stock_ledger,
        ),
    )
}


def may_export(ctx: ActorContext, report: ReportType, company_id) -> bool:
    if report.company_level:
        resource_type = report.permission.rsplit(".", 1)[0]
        return pdp.can(ctx, report.permission, pdp.Resource.ref(resource_type, company_id=company_id))
    return pdp.has_any_grant(ctx, report.permission).allowed
