"""Demand forecasting from the stock ledger (ANL-005): monthly consumption, then a moving average or
simple exponential smoothing. Accuracy is reported as the mean absolute deviation of one-step-ahead
forecasts over the history, so planners can judge how far to trust the number."""

from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Sum
from django.db.models.functions import TruncMonth

from apps.inventory.models import StockLedgerEntry

ZERO = Decimal("0")
Q3 = Decimal("0.001")
# Outflows that represent demand, with their reversals (returns flow back in and reduce demand).
# Transfers and production_issue_in/consumption are internal movements and would double count.
DEMAND_MOVEMENTS = ("sales_issue", "sales_return", "production_issue", "production_return_in", "backflush")


def _month(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


def monthly_demand(company_id, item_id, months: int, as_of: date, warehouse_ids=None) -> list[dict]:
    """The last `months` complete months before the month of `as_of`, zero-filled."""
    end = _month(as_of)
    start = _add_months(end, -months)
    q = StockLedgerEntry.objects.filter(
        company_id=company_id,
        item_id=item_id,
        movement_type__in=DEMAND_MOVEMENTS,
        posting_date__gte=start,
        posting_date__lt=end,
    )
    if warehouse_ids is not None:
        q = q.filter(warehouse_id__in=list(warehouse_ids))
    totals = {
        row["m"].date() if hasattr(row["m"], "date") else row["m"]: -row["q"]
        for row in q.annotate(m=TruncMonth("posting_date")).values("m").annotate(q=Sum("quantity"))
    }
    return [{"month": _add_months(start, i), "demand": totals.get(_add_months(start, i), ZERO)} for i in range(months)]


def _moving_average(series: list[Decimal], window: int) -> tuple[list[Decimal | None], Decimal]:
    fitted: list[Decimal | None] = []
    for i in range(len(series)):
        past = series[max(0, i - window) : i]
        fitted.append(sum(past, ZERO) / len(past) if len(past) == window else None)
    tail = series[-window:]
    return fitted, sum(tail, ZERO) / len(tail) if tail else ZERO


def _exponential(series: list[Decimal], alpha: Decimal) -> tuple[list[Decimal | None], Decimal]:
    if not series:
        return [], ZERO
    level = series[0]
    fitted: list[Decimal | None] = [None]
    for value in series[1:]:
        fitted.append(level)
        level = alpha * value + (1 - alpha) * level
    return fitted, level


def forecast(
    company_id,
    item_id,
    *,
    as_of: date,
    method: str = "moving_average",
    history_months: int = 12,
    horizon_months: int = 3,
    window: int = 3,
    alpha: Decimal = Decimal("0.3"),
    warehouse_ids=None,
) -> dict:
    if method not in ("moving_average", "exponential_smoothing"):
        raise ValueError(method)
    history = monthly_demand(company_id, item_id, history_months, as_of, warehouse_ids)
    series = [h["demand"] for h in history]
    if method == "moving_average":
        fitted, next_value = _moving_average(series, window)
    else:
        fitted, next_value = _exponential(series, alpha)
    errors = [abs(actual - f) for actual, f in zip(series, fitted, strict=True) if f is not None]
    next_value = max(next_value, ZERO).quantize(Q3, rounding=ROUND_HALF_UP)
    start = _month(as_of)
    return {
        "method": method,
        "parameters": {"window": window} if method == "moving_average" else {"alpha": alpha},
        "history": history,
        # Both methods are level-only (no trend or seasonality), so every future month gets the same value.
        "forecast": [{"month": _add_months(start, i), "demand": next_value} for i in range(horizon_months)],
        "mad": (sum(errors, ZERO) / len(errors)).quantize(Q3, rounding=ROUND_HALF_UP) if errors else None,
        "observations": len(errors),
    }
