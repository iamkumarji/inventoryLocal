from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

import pytest
from django.db import transaction
from django.utils import timezone

from apps.analytics import dashboards, forecasting, kpis, services
from apps.analytics.models import ReportJob
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation
from apps.core.ids import uuid7
from apps.core.models import FeatureFlag
from apps.finance import subledger
from apps.finance.models import Account, BankAccount, OpenItem
from apps.inventory.engine import Move, post_stock
from apps.partners.models import CustomerProfile, Partner
from apps.sales import services as sales
from conftest import ctx_for

pytestmark = [pytest.mark.django_db, pytest.mark.req("ANL-004")]
D = Decimal
TODAY = timezone.localdate


@pytest.fixture(autouse=True)
def modules(db):
    for key in ("module.analytics", "module.sales", "module.inventory", "module.finance", "module.partners"):
        FeatureFlag.objects.create(key=key, enabled_default=True)


@pytest.fixture
def trading(org, books, plant, make_item, make_user, grant, system_ctx, ctx, uoms, make_warehouse):
    """Opening stock of 20 @ ₹700, an order of 10 @ ₹1,000 delivered and invoiced, ₹5,000 received."""
    item = make_item("CAB", group="FG", uom="nos", item_type="finished_good", is_saleable=True)
    second_store = make_warehouse(plant["branch"], code="WH2")
    with transaction.atomic():
        post_stock(
            system_ctx,
            company_id=books.pk,
            posting_date=TODAY(),
            source_type="test.opening",
            source_id=uuid7(),
            moves=[
                Move(
                    item=item,
                    warehouse=plant["fg"],
                    quantity=D("20"),
                    movement_type="opening",
                    unit_cost=D("700"),
                    contra_key="inventory_adjustment",
                ),
                Move(
                    item=item,
                    warehouse=second_store,
                    quantity=D("5"),
                    movement_type="opening",
                    unit_cost=D("700"),
                    contra_key="inventory_adjustment",
                ),
            ],
        )
    customer = Partner.objects.create(
        organization=org, code="C1", name="Metro", is_customer=True, gstin="27AAPFU0939F1ZV", state_code="27"
    )
    CustomerProfile.objects.create(organization=org, partner=customer, credit_limit=D("100000"), credit_days=30)
    clerk = make_user()
    grant(
        clerk,
        [
            "sales.sales_order.create",
            "sales.sales_order.update",
            "sales.sales_order.read",
            "sales.delivery.create",
            "sales.delivery.post",
            "sales.invoice.create",
            "sales.invoice.post",
            "finance.payment.create",
            "finance.payment.update",
            "finance.payment.post",
        ],
        books,
    )
    c = ctx(clerk)
    so = sales.submit_order(
        c,
        sales.create_order(
            c,
            company=books,
            branch=plant["branch"],
            customer=customer,
            order_date=TODAY(),
            requested_date=TODAY(),
            lines=[
                {"item": item, "quantity": D("10"), "uom": uoms["nos"], "rate": D("1000"), "warehouse": plant["fg"]}
            ],
        ),
        on=TODAY(),
    )
    sales.post_delivery(
        c,
        sales.create_delivery(
            c,
            order=so,
            warehouse=plant["fg"],
            delivery_date=TODAY(),
            lines=[{"so_line": so.lines.get(), "quantity": D("10")}],
        ),
    )
    inv = sales.post_invoice(c, sales.create_invoice(c, order=so, invoice_date=TODAY()))
    bank = BankAccount.objects.create(
        company=books, account=Account.objects.get(company=books, code="1110"), bank_name="SBI"
    )
    receipt = subledger.create_payment(
        c,
        company=books,
        kind="customer_receipt",
        partner=customer,
        bank_account=bank,
        payment_date=TODAY(),
        mode="neft",
        amount=D("5000"),
        allocations=[{"open_item": OpenItem.objects.get(document_id=inv.pk), "amount": D("5000")}],
    )
    subledger.post_payment(c, subledger.submit_payment(c, receipt))
    return {"item": item, "customer": customer, "invoice": inv, "store2": second_store, "plant": plant}


def test_kpis_are_derived_from_the_ledgers(trading, books):
    d1 = TODAY().replace(day=1)
    cash = kpis.cash_position(books.pk, TODAY())
    assert cash["value"] == D("5000") and [a["account"] for a in cash["accounts"]] == ["1100", "1110"]
    turns = kpis.inventory_turns(books.pk, d1, TODAY())
    # COGS 7,000 over average inventory (0 opening + 10,500 closing) / 2
    assert turns["cogs"] == D("7000") and turns["average_inventory"] == D("5250.00") and turns["value"] == D("1.33")
    days = (TODAY() - d1).days + 1
    dso = kpis.dso(books.pk, d1, TODAY())
    assert dso["receivables"] == D("5000") and dso["net_sales"] == D("10000")  # no HSN on the item: no GST
    assert dso["value"] == (D("5000") * days / D("10000")).quantize(D("0.01"), ROUND_HALF_UP)
    assert kpis.dpo(books.pk, d1, TODAY())["value"] == D("0.00")  # no payables
    assert kpis.otif(books.pk, d1, TODAY()) == {"value": D("100.00"), "lines": 1, "otif_lines": 1}
    assert kpis.production_yield(books.pk, d1, TODAY())["value"] is None  # nothing produced: no fake 0%


@pytest.mark.req("ANL-001")
def test_dashboards_show_only_what_the_user_may_see(trading, books, make_user, grant, api_for, plant):
    controller, storekeeper = make_user(), make_user()
    grant(controller, ["analytics.dashboard.read", "finance.report.read", "finance.open_item.read"], books)
    grant(
        storekeeper,
        ["analytics.dashboard.read", "inventory.stock_balance.read", "inventory.stock_adjustment.read"],
        plant["fg"],
    )

    body = api_for(controller, company=books).get("/api/v1/analytics/dashboards/finance/").json()
    shown = {w["key"]: w for w in body["widgets"]}
    assert shown["cash_position"]["value"] == "5000.0000"  # money is never a JSON float
    assert D(shown["receivables_overdue"]["value"]) == D("0")
    assert [h["key"] for h in body["hidden"]] == ["invoices_on_hold"]

    body = api_for(storekeeper, company=books).get("/api/v1/analytics/dashboards/warehouse/").json()
    shown = {w["key"]: w for w in body["widgets"]}
    # Only the FG store the storekeeper is scoped to: 10 left @ ₹700; WH2's ₹3,500 is not included.
    assert D(shown["inventory_value"]["value"]) == D("7000") and shown["inventory_value"]["warehouses"] == 1
    hidden = {h["key"]: h for h in body["hidden"]}
    assert set(hidden) == {"inventory_turns"} and "value" not in hidden["inventory_turns"]

    assert api_for(make_user(), company=books).get("/api/v1/analytics/dashboards/finance/").status_code == 403
    assert api_for(controller, company=books).get("/api/v1/analytics/dashboards/nope/").status_code == 404


@pytest.mark.req("ANL-003")
def test_async_export_is_scoped_owned_and_rechecked(trading, books, make_user, grant, ctx, api_for, plant):
    owner, other = make_user(), make_user()
    grant(owner, ["analytics.report.create", "analytics.report.read", "inventory.stock_balance.export"], plant["fg"])
    grant(other, ["analytics.report.create", "analytics.report.read", "inventory.stock_balance.export"], books)
    with pytest.raises(AuthorizationDenied):  # needs finance.report.export at company level
        services.request_report(
            ctx(owner, books.pk),
            company_id=books.pk,
            report_type="trial_balance",
            params={"date_from": "2026-04-01", "date_to": "2026-10-31"},
        )

    client = api_for(owner, company=books)
    types = {t["code"] for t in client.get("/api/v1/analytics/report-types/").json()["report_types"]}
    assert types == {"stock_valuation", "stock_ageing"}
    response = client.post(
        "/api/v1/analytics/reports/",
        {"report_type": "stock_valuation", "params": {"as_of": str(TODAY())}},
        format="json",
    )
    assert response.status_code == 202
    job = services.run_report(response.json()["id"])  # what the worker does
    assert job.status == "done" and job.row_count == 1
    csv = client.get(f"/api/v1/analytics/reports/{job.pk}/download/")
    assert csv.status_code == 200 and csv["Content-Type"].startswith("text/csv")
    body = csv.content.decode()
    assert "WH2" not in body and body.splitlines()[1].startswith("CAB,")  # only the scoped warehouse

    # Exports are personal: another user with broader rights can't see or fetch it.
    assert api_for(other, company=books).get(f"/api/v1/analytics/reports/{job.pk}/download/").status_code == 404
    with pytest.raises(AuthorizationDenied):
        services.download(ctx(other, books.pk), job)

    # A queued export re-checks permission when it runs; revoked access fails the job.
    queued = services.request_report(
        ctx(owner, books.pk), company_id=books.pk, report_type="stock_ageing", params={"as_of": str(TODAY())}
    )
    owner.role_assignments.all().delete()  # signals refresh the cached authorization snapshot
    queued = services.run_report(queued.pk)
    assert queued.status == "failed" and queued.result_csv == ""
    with pytest.raises(AuthorizationDenied):
        services.download(ctx(owner, books.pk), job)


def test_csv_cells_cannot_inject_formulas():
    import csv
    import io

    out = services._to_csv([{"name": '=HYPERLINK("x")', "amount": D("-5")}, {"name": "+1", "amount": D("2")}])
    rows = list(csv.DictReader(io.StringIO(out)))
    assert rows[0] == {"name": '\'=HYPERLINK("x")', "amount": "-5"}  # numbers untouched
    assert rows[1]["name"] == "'+1"


def test_expired_exports_are_purged(books, make_user):
    user = make_user()
    ReportJob.objects.create(
        company=books, report_type="stock_valuation", expires_at=timezone.now(), created_by=user, status="done"
    )
    assert services.purge_expired() == 1
    with pytest.raises(BusinessRuleViolation):
        services.download(
            ctx_for(user, books.pk),
            ReportJob.objects.create(
                company=books,
                report_type="stock_valuation",
                created_by=user,
                status="queued",
                expires_at=timezone.now() + timedelta(days=1),
            ),
        )


@pytest.mark.req("ANL-005")
def test_forecast_from_monthly_consumption(books, plant, make_item, system_ctx, fiscal_year):
    item = make_item("BOLT", uom="nos")
    first = fiscal_year.start_date
    months = []
    m = first
    while m < TODAY().replace(day=1):
        months.append(m)
        m = date(m.year + (m.month == 12), m.month % 12 + 1, 1)
    demand = [D(v) for v in ("10", "20", "30", "40", "50", "60", "70", "80", "90", "100", "110", "120")][: len(months)]
    with transaction.atomic():
        post_stock(
            system_ctx,
            company_id=books.pk,
            posting_date=first,
            source_type="test.opening",
            source_id=uuid7(),
            moves=[
                Move(
                    item=item,
                    warehouse=plant["rm"],
                    quantity=D("10000"),
                    movement_type="opening",
                    unit_cost=D("1"),
                    contra_key="inventory_adjustment",
                )
            ],
        )
        for month, qty in zip(months, demand, strict=True):
            post_stock(
                system_ctx,
                company_id=books.pk,
                posting_date=month + timedelta(days=9),
                source_type="test.consume",
                source_id=uuid7(),
                moves=[
                    Move(
                        item=item,
                        warehouse=plant["rm"],
                        quantity=-qty,
                        movement_type="production_issue",
                        contra_key="inventory_adjustment",
                    )
                ],
            )
            # A transfer is internal and must not count as demand.
            post_stock(
                system_ctx,
                company_id=books.pk,
                posting_date=month + timedelta(days=10),
                source_type="test.move",
                source_id=uuid7(),
                moves=[
                    Move(item=item, warehouse=plant["rm"], quantity=-D("1"), movement_type="transfer_out"),
                    Move(
                        item=item,
                        warehouse=plant["wip"],
                        quantity=D("1"),
                        movement_type="transfer_in",
                        value_from_previous=True,
                    ),
                ],
            )
    if len(months) < 3:
        pytest.skip("needs three complete months of this fiscal year")
    n = len(months)
    ma = forecasting.forecast(books.pk, item.pk, as_of=TODAY(), history_months=n, window=3)
    assert [h["demand"] for h in ma["history"]] == demand
    assert ma["forecast"][0]["demand"] == (sum(demand[-3:]) / 3).quantize(D("0.001"), ROUND_HALF_UP)
    assert ma["mad"] == D("20.000") and ma["observations"] == n - 3  # linear growth: always 20 behind
    ses = forecasting.forecast(
        books.pk, item.pk, as_of=TODAY(), method="exponential_smoothing", history_months=n, alpha=D("0.5")
    )
    level = demand[0]
    for v in demand[1:]:
        level = D("0.5") * v + D("0.5") * level
    assert ses["forecast"][0]["demand"] == level.quantize(D("0.001"), ROUND_HALF_UP)


def test_every_dashboard_widget_is_defined():
    for name, keys in dashboards.DASHBOARDS.items():
        assert keys and all(k in dashboards.WIDGETS for k in keys), name
