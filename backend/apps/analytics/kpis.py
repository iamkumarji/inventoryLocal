"""KPIs computed from posted ledgers (GL, stock ledger, open items) and operational documents.

Every function is a pure read for one company and returns its value with the inputs it was derived
from, so a figure on a dashboard can always be traced back. A KPI whose denominator is zero returns
None rather than a misleading 0 or infinity.
"""

from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import F, Q, Sum
from django.db.models.functions import Coalesce

from apps.finance.models import Account, BankAccount, Budget, BudgetLine, JournalLine
from apps.finance.posting import resolve_account
from apps.inventory.models import StockLedgerEntry
from apps.manufacturing.models import ProductionOrder
from apps.organization.models import FiscalPeriod
from apps.sales.models import DeliveryLine, SalesOrderLine

ZERO = Decimal("0")
Q2 = Decimal("0.01")


def _ratio(numerator: Decimal, denominator: Decimal, scale: Decimal = Decimal(1)) -> Decimal | None:
    if not denominator:
        return None
    return (numerator * scale / denominator).quantize(Q2, rounding=ROUND_HALF_UP)


def _gl(company_id, account_ids, date_from: date | None = None, date_to: date | None = None) -> Decimal:
    """Debit-positive balance of the accounts over the range (open-ended when a bound is None)."""
    q = Q(entry__company_id=company_id, entry__status="posted", account_id__in=list(account_ids))
    if date_from:
        q &= Q(entry__entry_date__gte=date_from)
    if date_to:
        q &= Q(entry__entry_date__lte=date_to)
    return JournalLine.objects.filter(q).aggregate(b=Coalesce(Sum(F("debit") - F("credit")), ZERO))["b"]


def _account(company_id, key: str) -> list:
    return [resolve_account(company_id, key).pk]


def inventory_value(company_id, as_of: date, warehouse_ids=None) -> Decimal:
    q = StockLedgerEntry.objects.filter(company_id=company_id, posting_date__lte=as_of)
    if warehouse_ids is not None:
        q = q.filter(warehouse_id__in=list(warehouse_ids))
    return q.aggregate(v=Coalesce(Sum("value"), ZERO))["v"]


def inventory_turns(company_id, date_from: date, date_to: date) -> dict:
    """COGS for the period over average inventory (opening and closing), also annualised."""
    cogs = _gl(company_id, _account(company_id, "cogs"), date_from, date_to)
    opening = inventory_value(company_id, date_from - timedelta(days=1))
    closing = inventory_value(company_id, date_to)
    average = (opening + closing) / 2
    days = (date_to - date_from).days + 1
    turns = _ratio(cogs, average)
    return {
        "value": turns,
        "annualised": _ratio(cogs * 365, average * days) if days else None,
        "cogs": cogs,
        "average_inventory": average.quantize(Q2),
    }


def dso(company_id, date_from: date, date_to: date) -> dict:
    """Days sales outstanding: receivables at period end over net sales, times days in the period."""
    revenue = -_gl(company_id, _account(company_id, "sales_revenue"), date_from, date_to)
    returns = _gl(company_id, _account(company_id, "sales_returns"), date_from, date_to)
    receivables = _gl(company_id, _account(company_id, "ar"), None, date_to)
    days = (date_to - date_from).days + 1
    net = revenue - returns
    return {"value": _ratio(receivables * days, net) if net > 0 else None, "receivables": receivables, "net_sales": net}


def dpo(company_id, date_from: date, date_to: date) -> dict:
    """Days payables outstanding on the cost-of-sales basis: payables at period end over COGS."""
    payables = -_gl(company_id, _account(company_id, "ap"), None, date_to)
    cogs = _gl(company_id, _account(company_id, "cogs"), date_from, date_to)
    days = (date_to - date_from).days + 1
    return {"value": _ratio(payables * days, cogs) if cogs > 0 else None, "payables": payables, "cogs": cogs}


def cash_position(company_id, as_of: date) -> dict:
    """Cash-in-hand accounts plus every company bank account's GL balance."""
    accounts = {a.pk: a for a in Account.objects.filter(company_id=company_id, sub_type="cash", is_group=False)}
    for bank in BankAccount.objects.filter(company_id=company_id).select_related("account"):
        accounts[bank.account_id] = bank.account
    rows = [
        {"account": a.code, "name": a.name, "balance": _gl(company_id, [a.pk], None, as_of)}
        for a in sorted(accounts.values(), key=lambda a: a.code)
    ]
    return {"value": sum((r["balance"] for r in rows), ZERO), "accounts": rows}


def otif(company_id, date_from: date, date_to: date, orders=None) -> dict:
    """On time in full: order lines due in the period that were completely delivered by their
    requested date. Lines are only judged once their requested date has passed. `orders` narrows the
    population (e.g. to the branches a user may see)."""
    due_until = min(date_to, date.today())
    lines = SalesOrderLine.objects.filter(
        order__company_id=company_id,
        order__status__in=("approved", "closed"),
        order__requested_date__gte=date_from,
        order__requested_date__lte=due_until,
    ).select_related("order")
    if orders is not None:
        lines = lines.filter(order__in=orders)
    total = good = 0
    for line in lines:
        delivered = DeliveryLine.objects.filter(
            so_line=line, delivery__status="posted", delivery__delivery_date__lte=line.order.requested_date
        ).aggregate(q=Coalesce(Sum("quantity"), ZERO))["q"]
        total += 1
        good += delivered >= line.stock_quantity
    return {"value": _ratio(Decimal(good), Decimal(total), Decimal(100)), "lines": total, "otif_lines": good}


def production_yield(company_id, date_from: date, date_to: date, orders=None) -> dict:
    """Material yield of orders closed in the period: material value that became good output over
    material value consumed or scrapped. Scrap % is the complement."""
    agg = (
        (orders if orders is not None else ProductionOrder.objects)
        .filter(
            company_id=company_id,
            status=ProductionOrder.Status.CLOSED,
            closed_at__date__gte=date_from,
            closed_at__date__lte=date_to,
        )
        .aggregate(
            material=Coalesce(Sum("material_cost"), ZERO),
            scrap=Coalesce(Sum("scrap_cost"), ZERO),
            output=Coalesce(Sum("produced_quantity"), ZERO),
        )
    )
    total = agg["material"] + agg["scrap"]
    return {
        "value": _ratio(agg["material"], total, Decimal(100)),
        "scrap_pct": _ratio(agg["scrap"], total, Decimal(100)),
        "material_cost": agg["material"],
        "scrap_cost": agg["scrap"],
        "output_quantity": agg["output"],
    }


def budget_variance(company_id, as_of: date) -> dict:
    """Year to date for approved budgets of the fiscal year containing the date: planned amounts of the
    periods that have started, against actuals (same debit-positive sign as the budget lines)."""
    period = (
        FiscalPeriod.objects.filter(fiscal_year__company_id=company_id, start_date__lte=as_of, end_date__gte=as_of)
        .select_related("fiscal_year")
        .first()
    )
    if period is None:
        return {"value": None, "planned": ZERO, "actual": ZERO, "budgets": 0}
    fy = period.fiscal_year
    budgets = Budget.objects.filter(company_id=company_id, fiscal_year=fy, status="approved")
    planned = actual = ZERO
    for line in (
        BudgetLine.objects.filter(budget__in=budgets, period_no__lte=period.period_no)
        .values("account_id", "cost_center_id")
        .annotate(planned=Sum("amount"))
    ):
        planned += line["planned"]
        q = JournalLine.objects.filter(
            entry__company_id=company_id,
            entry__status="posted",
            account_id=line["account_id"],
            entry__entry_date__gte=fy.start_date,
            entry__entry_date__lte=as_of,
        )
        if line["cost_center_id"]:
            q = q.filter(cost_center_id=line["cost_center_id"])
        actual += q.aggregate(a=Coalesce(Sum(F("debit") - F("credit")), ZERO))["a"]
    count = budgets.count()
    return {
        "value": planned - actual if count else None,  # no approved budget: no variance to show, not zero
        "variance_pct": _ratio(planned - actual, planned, Decimal(100)),
        "planned": planned,
        "actual": actual,
        "budgets": count,
    }
