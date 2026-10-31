"""Role dashboards (ANL-001). A dashboard is a list of widgets; each widget declares the domain
permission it needs and computes its figure only over rows that permission lets the user see.

Company-wide financial figures (cash, DSO, DPO, turns, budgets) need `finance.report.read` at
company level. Operational widgets are scope-aware: a branch sales manager sees OTIF for their
branches, a storekeeper sees the value of their warehouses. Widgets the user may not see are named in
`hidden` without any value, so the UI can explain the gap without leaking the number.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from django.db.models import Count, F, Sum
from django.db.models.functions import Coalesce

from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.finance.models import OpenItem, SupplierInvoice
from apps.inventory.models import ItemValuation, StockAdjustment, StockCount, StockTransfer
from apps.manufacturing.models import ProductionOrder
from apps.procurement.models import PurchaseOrder
from apps.sales.models import SalesOrder

from . import kpis

ZERO = kpis.ZERO


@dataclass(frozen=True)
class Widget:
    key: str
    label: str
    unit: str  # inr | days | pct | ratio | count
    permission: str
    company_level: bool  # needs a company-wide grant, not just some scope
    compute: Callable[[ActorContext, object, date, date], dict]


def _scoped(ctx, action, queryset):
    return pdp.filter_queryset(ctx, action, queryset)


def _receivables_overdue(ctx, company_id, d1, d2):
    items = OpenItem.objects.filter(company_id=company_id, kind="receivable", is_open=True, due_date__lt=d2)
    agg = items.aggregate(v=Coalesce(Sum(F("amount") - F("settled")), ZERO), n=Count("partner", distinct=True))
    return {"value": agg["v"], "customers": agg["n"]}


def _payables_due(ctx, company_id, d1, d2):
    items = OpenItem.objects.filter(company_id=company_id, kind="payable", is_open=True, due_date__lte=d2)
    agg = items.aggregate(v=Coalesce(Sum(F("amount") - F("settled")), ZERO), n=Count("partner", distinct=True))
    return {"value": -agg["v"], "suppliers": agg["n"]}


def _open_purchase_orders(ctx, company_id, d1, d2):
    pos = _scoped(ctx, "procurement.purchase_order.read", PurchaseOrder.objects.filter(company_id=company_id))
    open_pos = pos.filter(status="approved").exclude(receipt_status="received")
    agg = open_pos.aggregate(n=Count("id"), v=Coalesce(Sum(F("subtotal") + F("tax_total")), ZERO))
    return {"value": agg["n"], "order_value": agg["v"], "awaiting_approval": pos.filter(status="submitted").count()}


def _invoices_on_hold(ctx, company_id, d1, d2):
    invoices = SupplierInvoice.objects.filter(company_id=company_id, status="submitted", match_status="variance")
    invoices = _scoped(ctx, "finance.supplier_invoice.read", invoices)
    return {"value": invoices.count()}


def _open_sales_orders(ctx, company_id, d1, d2):
    orders = _scoped(ctx, "sales.sales_order.read", SalesOrder.objects.filter(company_id=company_id))
    agg = orders.filter(status="approved").aggregate(
        n=Count("id"), v=Coalesce(Sum(F("subtotal") + F("tax_total")), ZERO)
    )
    blocked = orders.filter(status="submitted", credit_status="blocked").count()
    return {"value": agg["n"], "order_value": agg["v"], "credit_blocked": blocked}


def _otif(ctx, company_id, d1, d2):
    orders = _scoped(ctx, "sales.sales_order.read", SalesOrder.objects.filter(company_id=company_id))
    return kpis.otif(company_id, d1, d2, orders=orders)


def _yield(ctx, company_id, d1, d2):
    orders = _scoped(ctx, "manufacturing.production_order.read", ProductionOrder.objects.all())
    return kpis.production_yield(company_id, d1, d2, orders=orders)


def _production_backlog(ctx, company_id, d1, d2):
    orders = _scoped(ctx, "manufacturing.production_order.read", ProductionOrder.objects.filter(company_id=company_id))
    by_status = dict(
        orders.filter(status__in=("draft", "released", "in_progress"))
        .values_list("status")
        .annotate(n=Count("id"))
        .values_list("status", "n")
    )
    late = orders.filter(status__in=("released", "in_progress"), planned_end__lt=d2).count()
    return {"value": sum(by_status.values()), "by_status": by_status, "late": late}


def _inventory_value(ctx, company_id, d1, d2):
    rows = _scoped(ctx, "inventory.stock_balance.read", ItemValuation.objects.filter(company_id=company_id))
    warehouse_ids = set(rows.values_list("warehouse_id", flat=True))
    return {"value": kpis.inventory_value(company_id, d2, warehouse_ids), "warehouses": len(warehouse_ids)}


def _stock_documents(ctx, company_id, d1, d2):
    def scoped(action, model, **filters):
        return _scoped(ctx, action, model.objects.filter(company_id=company_id, **filters)).count()

    detail = {
        "adjustments_awaiting_approval": scoped("inventory.stock_adjustment.read", StockAdjustment, status="submitted"),
        "transfers_in_transit": scoped("inventory.stock_transfer.read", StockTransfer, status="dispatched"),
        "counts_open": scoped("inventory.stock_count.read", StockCount, status__in=("counting", "submitted")),
    }
    return {"value": sum(detail.values()), **detail}


def _headcount(ctx, company_id, d1, d2):
    from apps.hr.models import Employee

    people = _scoped(ctx, "hr.employee.read", Employee.objects.filter(company_id=company_id))
    return {
        "value": people.filter(status="active").count(),
        "joined": people.filter(date_of_joining__gte=d1, date_of_joining__lte=d2).count(),
        "left": people.filter(date_of_exit__gte=d1, date_of_exit__lte=d2).count(),
    }


def _leave_pending(ctx, company_id, d1, d2):
    from apps.hr.models import LeaveRequest

    requests = _scoped(ctx, "hr.leave_request.read", LeaveRequest.objects.filter(company_id=company_id))
    return {"value": requests.filter(status="submitted").count()}


def _payroll_cost(ctx, company_id, d1, d2):
    from apps.hr.models import PayrollRun

    runs = PayrollRun.objects.filter(company_id=company_id, status="posted").order_by("-year", "-month")
    latest = runs.first()
    if latest is None:
        return {"value": None}
    totals = latest.payslips.aggregate(gross=Coalesce(Sum("gross"), ZERO), net=Coalesce(Sum("net_pay"), ZERO))
    return {
        "value": totals["gross"],
        "net": totals["net"],
        "period": f"{latest.year}-{latest.month:02d}",
        "employees": latest.payslips.count(),
    }


# Employee self-service widgets: always about the caller, so no extra permission beyond being signed in.
def _my_leave(ctx, company_id, d1, d2):
    from apps.hr.models import LeaveBalance

    employee_id = getattr(ctx.user, "employee_id", None)
    if not employee_id:
        return {"value": None, "balances": []}
    rows = LeaveBalance.objects.filter(employee_id=employee_id, year=d2.year).select_related("leave_type")
    balances = [{"leave_type": b.leave_type.name, "available": b.allocated - b.used} for b in rows]
    return {"value": sum((b["available"] for b in balances), ZERO), "balances": balances}


def _my_claims(ctx, company_id, d1, d2):
    from apps.expenses.models import ExpenseClaim

    claims = ExpenseClaim.objects.filter(created_by=ctx.user).exclude(status__in=("paid", "cancelled", "rejected"))
    agg = claims.aggregate(n=Count("id"), v=Coalesce(Sum("amount"), ZERO))
    return {"value": agg["n"], "amount": agg["v"]}


def _my_tasks(ctx, company_id, d1, d2):
    from django.utils import timezone

    from apps.collaboration.models import Task

    tasks = Task.objects.filter(assignee=ctx.user).exclude(status__in=("done", "cancelled"))
    return {"value": tasks.count(), "overdue": tasks.filter(due_at__lt=timezone.now()).count()}


FINANCE = "finance.report.read"
WIDGETS = {
    w.key: w
    for w in (
        Widget("cash_position", "Cash position", "inr", FINANCE, True, lambda c, k, a, b: kpis.cash_position(k, b)),
        Widget("dso", "Days sales outstanding", "days", FINANCE, True, lambda c, k, a, b: kpis.dso(k, a, b)),
        Widget("dpo", "Days payables outstanding", "days", FINANCE, True, lambda c, k, a, b: kpis.dpo(k, a, b)),
        Widget(
            "inventory_turns",
            "Inventory turns",
            "ratio",
            FINANCE,
            True,
            lambda c, k, a, b: kpis.inventory_turns(k, a, b),
        ),
        Widget(
            "budget_variance",
            "Budget variance (YTD)",
            "inr",
            FINANCE,
            True,
            lambda c, k, a, b: kpis.budget_variance(k, b),
        ),
        Widget(
            "receivables_overdue", "Receivables overdue", "inr", "finance.open_item.read", True, _receivables_overdue
        ),
        Widget("payables_due", "Payables due", "inr", "finance.open_item.read", True, _payables_due),
        Widget(
            "invoices_on_hold",
            "Supplier invoices on hold",
            "count",
            "finance.supplier_invoice.read",
            False,
            _invoices_on_hold,
        ),
        Widget(
            "open_purchase_orders",
            "Open purchase orders",
            "count",
            "procurement.purchase_order.read",
            False,
            _open_purchase_orders,
        ),
        Widget("open_sales_orders", "Open sales orders", "count", "sales.sales_order.read", False, _open_sales_orders),
        Widget("otif", "On time in full", "pct", "sales.sales_order.read", False, _otif),
        Widget("production_yield", "Material yield", "pct", "manufacturing.production_order.read", False, _yield),
        Widget(
            "production_backlog",
            "Production orders open",
            "count",
            "manufacturing.production_order.read",
            False,
            _production_backlog,
        ),
        Widget("inventory_value", "Inventory value", "inr", "inventory.stock_balance.read", False, _inventory_value),
        Widget(
            "stock_documents",
            "Stock documents pending",
            "count",
            "inventory.stock_adjustment.read",
            False,
            _stock_documents,
        ),
        Widget("headcount", "Headcount", "count", "hr.employee.read", False, _headcount),
        Widget("leave_pending", "Leave awaiting decision", "count", "hr.leave_request.read", False, _leave_pending),
        Widget("payroll_cost", "Payroll cost (last posted month)", "inr", "hr.salary.read", True, _payroll_cost),
        Widget("my_leave", "My leave balance (days)", "days", "", False, _my_leave),
        Widget("my_claims", "My open expense claims", "count", "", False, _my_claims),
        Widget("my_tasks", "My open tasks", "count", "", False, _my_tasks),
    )
}

DASHBOARDS = {
    "management": ["cash_position", "dso", "dpo", "inventory_turns", "otif", "production_yield", "budget_variance"],
    "finance": [
        "cash_position",
        "receivables_overdue",
        "payables_due",
        "dso",
        "dpo",
        "budget_variance",
        "invoices_on_hold",
    ],
    "procurement": ["open_purchase_orders", "invoices_on_hold", "payables_due", "dpo"],
    "production": ["production_backlog", "production_yield", "inventory_value"],
    "warehouse": ["inventory_value", "stock_documents", "inventory_turns"],
    "sales": ["open_sales_orders", "otif", "receivables_overdue", "dso"],
    "hr": ["headcount", "leave_pending", "payroll_cost"],
    "employee": ["my_tasks", "my_leave", "my_claims"],
}


def visible(ctx: ActorContext, widget: Widget, company_id) -> bool:
    if not widget.permission:  # the caller's own data
        return True
    if widget.company_level:
        resource_type = widget.permission.rsplit(".", 1)[0]
        return pdp.can(ctx, widget.permission, pdp.Resource.ref(resource_type, company_id=company_id))
    return pdp.has_any_grant(ctx, widget.permission).allowed


def build(ctx: ActorContext, name: str, company_id, date_from: date, date_to: date) -> dict:
    widgets, hidden = [], []
    for key in DASHBOARDS[name]:
        widget = WIDGETS[key]
        if not visible(ctx, widget, company_id):
            hidden.append({"key": key, "label": widget.label, "needs": widget.permission})
            continue
        data = widget.compute(ctx, company_id, date_from, date_to)
        widgets.append({"key": key, "label": widget.label, "unit": widget.unit, **data})
    return {"dashboard": name, "date_from": date_from, "date_to": date_to, "widgets": widgets, "hidden": hidden}
