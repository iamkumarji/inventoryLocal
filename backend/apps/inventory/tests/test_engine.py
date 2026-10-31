import threading
from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import DatabaseError, connection, transaction

from apps.core.exceptions import BusinessRuleViolation
from apps.core.ids import uuid7
from apps.inventory import selectors
from apps.inventory.engine import Move, get_or_create_batch, post_stock, release, reserve
from apps.inventory.models import ItemValuation, SerialNumber, StockLedgerEntry, StockTransaction
from conftest import gl_balance

pytestmark = [pytest.mark.django_db, pytest.mark.req("INV-002")]
D = Decimal


def receive(ctx, company, item, wh, qty, cost, **kw):
    with transaction.atomic():
        return post_stock(
            ctx,
            company_id=company.pk,
            posting_date=kw.pop("on", None) or _today(company),
            moves=[
                Move(
                    item=item,
                    warehouse=wh,
                    quantity=D(qty),
                    movement_type="receipt",
                    unit_cost=D(cost),
                    contra_key="grni",
                    **kw,
                )
            ],
            source_type="test.receipt",
            source_id=uuid7(),
        )


def issue(ctx, company, item, wh, qty, **kw):
    with transaction.atomic():
        return post_stock(
            ctx,
            company_id=company.pk,
            posting_date=kw.pop("on", None) or _today(company),
            moves=[Move(item=item, warehouse=wh, quantity=-D(qty), movement_type="issue", contra_key="cogs", **kw)],
            source_type="test.issue",
            source_id=uuid7(),
        )


def _today(company):
    from django.utils import timezone

    return timezone.localdate()


@pytest.mark.req("INV-012")
def test_moving_average_valuation_and_gl(system_ctx, books, plant, make_item):
    item = make_item("STEEL")
    rm = plant["rm"]
    receive(system_ctx, books, item, rm, "100", "50")  # 5,000
    receive(system_ctx, books, item, rm, "100", "60")  # 6,000 -> avg 55
    val = ItemValuation.objects.get(item=item, warehouse=rm)
    assert (val.quantity, val.value, val.avg_cost) == (D("200"), D("11000"), D("55"))
    txn = issue(system_ctx, books, item, rm, "30")  # 30 x 55 = 1,650
    entry = StockLedgerEntry.objects.get(transaction=txn)
    assert (entry.quantity, entry.unit_cost, entry.value) == (D("-30"), D("55"), D("-1650"))
    assert (entry.balance_quantity_after, entry.balance_value_after) == (D("170"), D("9350"))
    # GL mirrors the stock ledger exactly
    assert gl_balance(books, "1300") == D("9350")
    assert gl_balance(books, "2150") == D("-11000")
    assert gl_balance(books, "5100") == D("1650")
    assert txn.journal_entry.status == "posted"


def test_issuing_everything_clears_value_residue(system_ctx, books, plant, make_item):
    item = make_item()
    receive(system_ctx, books, item, plant["rm"], "3", "10")
    receive(system_ctx, books, item, plant["rm"], "3", "10.01")  # avg 10.005
    issue(system_ctx, books, item, plant["rm"], "1")
    issue(system_ctx, books, item, plant["rm"], "5")
    val = ItemValuation.objects.get(item=item, warehouse=plant["rm"])
    assert (val.quantity, val.value) == (D("0"), D("0"))
    assert gl_balance(books, "1300") == D("0")


@pytest.mark.req("INV-011")
def test_negative_stock_blocked_unless_warehouse_and_permission_allow(
    system_ctx, books, plant, make_item, make_user, grant, ctx
):
    item = make_item()
    receive(system_ctx, books, item, plant["rm"], "5", "10")
    with pytest.raises(BusinessRuleViolation) as exc:
        issue(system_ctx, books, item, plant["rm"], "6")
    assert exc.value.code == "insufficient_stock" and exc.value.meta["available"] == "5.000000"
    plant["rm"].allow_negative_stock = True
    plant["rm"].save()
    user = make_user()
    grant(user, ["organization.company.read"], books)
    with pytest.raises(BusinessRuleViolation):
        issue(ctx(user), books, item, plant["rm"], "6")  # flag alone isn't enough
    issue(system_ctx, books, item, plant["rm"], "6")  # system postings (e.g. backflush) may go negative here
    assert ItemValuation.objects.get(item=item, warehouse=plant["rm"]).quantity == D("-1")


@pytest.mark.req("INV-007")
def test_reservations_protect_stock(system_ctx, books, plant, make_item):
    item = make_item()
    receive(system_ctx, books, item, plant["rm"], "10", "10")
    with transaction.atomic():
        res = reserve(
            system_ctx,
            company_id=books.pk,
            item=item,
            warehouse=plant["rm"],
            quantity=D("8"),
            source_type="test.order",
            source_id=uuid7(),
        )
    assert selectors.availability(books.pk, item.pk, plant["rm"].pk)["available"] == D("2")
    with pytest.raises(BusinessRuleViolation):
        issue(system_ctx, books, item, plant["rm"], "3")  # would eat reserved stock
    with pytest.raises(BusinessRuleViolation):
        reserve(
            system_ctx,
            company_id=books.pk,
            item=item,
            warehouse=plant["rm"],
            quantity=D("3"),
            source_type="test.order",
            source_id=uuid7(),
        )
    issue(system_ctx, books, item, plant["rm"], "8", consume_reservation=res)
    res.refresh_from_db()
    assert res.status == "consumed"
    assert selectors.availability(books.pk, item.pk, plant["rm"].pk)["available"] == D("2")
    with transaction.atomic():
        res2 = reserve(
            system_ctx,
            company_id=books.pk,
            item=item,
            warehouse=plant["rm"],
            quantity=D("2"),
            source_type="test.order",
            source_id=uuid7(),
        )
        release(system_ctx, res2)
    assert ItemValuation.objects.get(item=item, warehouse=plant["rm"]).reserved_quantity == 0


@pytest.mark.req("INV-004")
def test_batches_required_and_expired_batches_blocked(system_ctx, books, plant, make_item):
    item = make_item(tracking="batch")
    with pytest.raises(BusinessRuleViolation, match="needs a batch"):
        receive(system_ctx, books, item, plant["rm"], "5", "10")
    today = _today(books)
    batch = get_or_create_batch(books.pk, item, "B-001", expires_on=today - timedelta(days=1))
    receive(system_ctx, books, item, plant["rm"], "5", "10", batch=batch)
    with pytest.raises(BusinessRuleViolation) as exc:
        issue(system_ctx, books, item, plant["rm"], "1", batch=batch)
    assert exc.value.code == "batch_expired"
    issue(system_ctx, books, item, plant["rm"], "1", batch=batch, allow_expired=True)  # e.g. scrapping


@pytest.mark.req("INV-005")
def test_serial_numbers(system_ctx, books, plant, make_item):
    item = make_item(uom="nos", tracking="serial")
    with pytest.raises(BusinessRuleViolation, match="one unique serial"):
        receive(system_ctx, books, item, plant["fg"], "2", "100", serials=["S1"])
    receive(system_ctx, books, item, plant["fg"], "2", "100", serials=["S1", "S2"])
    with pytest.raises(BusinessRuleViolation, match="already in stock"):
        receive(system_ctx, books, item, plant["fg"], "1", "100", serials=["S1"])
    with pytest.raises(BusinessRuleViolation, match="isn't available"):
        issue(system_ctx, books, item, plant["fg"], "1", serials=["S9"])
    issue(system_ctx, books, item, plant["fg"], "1", serials=["S2"])
    assert SerialNumber.objects.get(serial="S2").status == "issued"
    assert SerialNumber.objects.get(serial="S1").status == "in_stock"


def test_transfer_legs_carry_exact_value(system_ctx, books, plant, make_item):
    item = make_item()
    receive(system_ctx, books, item, plant["rm"], "3", "10.01")
    with transaction.atomic():
        post_stock(
            system_ctx,
            company_id=books.pk,
            posting_date=_today(books),
            source_type="test.transfer",
            source_id=uuid7(),
            moves=[
                Move(item=item, warehouse=plant["rm"], quantity=D("-3"), movement_type="transfer_out"),
                Move(
                    item=item,
                    warehouse=plant["wip"],
                    quantity=D("3"),
                    movement_type="transfer_in",
                    value_from_previous=True,
                ),
            ],
        )
    assert ItemValuation.objects.get(item=item, warehouse=plant["wip"]).value == D("30.03")
    assert gl_balance(books, "1300") == D("0") and gl_balance(books, "1310") == D("30.03")


@pytest.mark.req("FND-002")
def test_closed_period_blocks_posting(system_ctx, books, plant, make_item, fiscal_year):
    item = make_item()
    period = fiscal_year.periods.get(start_date__lte=_today(books), end_date__gte=_today(books))
    period.inventory_locked = True
    period.save()
    with pytest.raises(BusinessRuleViolation, match="locked"):
        receive(system_ctx, books, item, plant["rm"], "1", "1")


def test_ledger_and_transactions_are_immutable(system_ctx, books, plant, make_item):
    item = make_item()
    txn = receive(system_ctx, books, item, plant["rm"], "1", "1")
    for sql in (
        "UPDATE stock_ledger_entries SET quantity = 2",
        "DELETE FROM stock_ledger_entries",
        "UPDATE stock_transactions SET reference = 'x'",
        "DELETE FROM stock_transactions",
        "UPDATE journal_lines SET debit = debit + 1 WHERE debit > 0",
        f"UPDATE journal_entries SET narration = 'x' WHERE id = '{txn.journal_entry_id}'",
    ):
        with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic(), connection.cursor() as cur:
            cur.execute(sql)


@pytest.mark.django_db(transaction=True)
@pytest.mark.req("INV-011")
def test_concurrent_issues_cannot_oversell(system_ctx, company, make_item, make_branch, make_warehouse):
    """Ten parallel issues of 2 units against 10 in stock: exactly 5 succeed, stock ends at 0."""
    from apps.finance.services import install_chart
    from apps.organization.services import create_fiscal_year

    create_fiscal_year(
        system_ctx, company=company, start_year=_today(company).year - (1 if _today(company).month < 4 else 0)
    )
    install_chart(system_ctx, company)
    wh = make_warehouse(make_branch(company), None, "RMX", warehouse_type="raw_material")
    item = make_item()
    receive(system_ctx, company, item, wh, "10", "10")
    results = []

    def worker():
        try:
            issue(system_ctx, company, item, wh, "2")
            results.append("ok")
        except BusinessRuleViolation:
            results.append("short")
        finally:
            connection.close()

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("ok") == 5 and results.count("short") == 5
    val = ItemValuation.objects.get(item=item, warehouse=wh)
    assert (val.quantity, val.value) == (D("0"), D("0"))
    assert StockTransaction.objects.filter(source_type="test.issue").count() == 5
