from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import DatabaseError, connection, transaction
from django.utils import timezone

from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition
from apps.finance import reports, services
from apps.finance.models import Account, AccountDetermination, JournalEntry
from apps.finance.posting import Line, post_journal, resolve_account, reverse_journal
from apps.partners.models import Partner
from conftest import gl_balance

pytestmark = [pytest.mark.django_db, pytest.mark.req("FIN-002")]
D = Decimal


@pytest.fixture(autouse=True)
def finance_enabled(db):
    from apps.core.models import FeatureFlag

    FeatureFlag.objects.create(key="module.finance", enabled_default=True)


def acc(company, code):
    return Account.objects.get(company=company, code=code)


def post(ctx, company, lines, on=None):
    with transaction.atomic():
        return post_journal(
            ctx,
            company_id=company.pk,
            entry_date=on or timezone.localdate(),
            lines=lines,
            narration="test",
            source_module="test",
        )


def test_chart_installed_with_rules(books):
    assert Account.objects.filter(company=books).count() > 40
    assert resolve_account(books.pk, "inventory").code == "1300"
    assert resolve_account(books.pk, "inventory", posting_group="FG").code == "1320"
    assert resolve_account(books.pk, "inventory", warehouse_type="wip").code == "1310"
    with pytest.raises(BusinessRuleViolation) as exc:
        resolve_account(books.pk, "nonexistent_key")
    assert exc.value.code == "account_determination_missing"


def test_post_balanced_entry_and_numbering(system_ctx, books):
    entry = post(
        system_ctx, books, [Line(D("100"), account=acc(books, "1110")), Line(D("-100"), account=acc(books, "3100"))]
    )
    assert entry.status == "posted" and entry.number.startswith("JE/") and entry.total == D("100")
    assert gl_balance(books, "1110") == D("100")


def test_unbalanced_and_invalid_lines_rejected(system_ctx, books, org):
    with pytest.raises(BusinessRuleViolation, match="doesn't balance"):
        post(
            system_ctx, books, [Line(D("100"), account=acc(books, "1110")), Line(D("-90"), account=acc(books, "3100"))]
        )
    with pytest.raises(BusinessRuleViolation, match="can't receive postings"):
        post(system_ctx, books, [Line(D("1"), account=acc(books, "1000")), Line(D("-1"), account=acc(books, "3100"))])
    with pytest.raises(BusinessRuleViolation, match="must name a customer"):
        post(system_ctx, books, [Line(D("1"), account=acc(books, "1200")), Line(D("-1"), account=acc(books, "4100"))])
    customer = Partner.objects.create(
        organization=org, code="C1", name="Cust", is_customer=True, gst_registration="unregistered"
    )
    post(
        system_ctx,
        books,
        [Line(D("1"), account=acc(books, "1200"), partner_id=customer.pk), Line(D("-1"), account=acc(books, "4100"))],
    )


def test_database_rejects_unbalanced_posted_entry(books, fiscal_year):
    """Even raw SQL can't commit a posted entry whose lines don't balance (deferred trigger)."""
    a, b = acc(books, "1110"), acc(books, "3100")
    with pytest.raises(DatabaseError, match="unbalanced_journal"), transaction.atomic():
        entry = JournalEntry.objects.create(company=books, entry_date=timezone.localdate(), narration="raw")
        from apps.finance.models import JournalLine

        JournalLine.objects.create(entry=entry, line_no=1, account=a, debit=D("10"))
        JournalLine.objects.create(entry=entry, line_no=2, account=b, credit=D("9"))
        JournalEntry.objects.filter(pk=entry.pk).update(status="posted")
        with connection.cursor() as cur:
            cur.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_posted_entries_are_immutable_and_reversed(system_ctx, books):
    entry = post(
        system_ctx, books, [Line(D("50"), account=acc(books, "1110")), Line(D("-50"), account=acc(books, "3100"))]
    )
    with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
        JournalEntry.objects.filter(pk=entry.pk).update(narration="edited")
    reversal = reverse_journal(system_ctx, entry, reversal_date=timezone.localdate(), reason="duplicate")
    assert reversal.is_reversal and reversal.reverses_id == entry.pk
    entry.refresh_from_db()
    assert entry.reversed_by_id == reversal.pk
    assert gl_balance(books, "1110") == 0
    with pytest.raises(InvalidStateTransition):
        reverse_journal(system_ctx, entry, reversal_date=timezone.localdate(), reason="again")


def test_closed_period_rejects_postings(system_ctx, books, fiscal_year):
    period = fiscal_year.periods.get(start_date__lte=timezone.localdate(), end_date__gte=timezone.localdate())
    period.status = "closed"
    period.save()
    with pytest.raises(BusinessRuleViolation, match="closed"):
        post(system_ctx, books, [Line(D("1"), account=acc(books, "1110")), Line(D("-1"), account=acc(books, "3100"))])


@pytest.mark.req("FIN-012")
def test_statements_balance(system_ctx, books, fiscal_year):
    post(system_ctx, books, [Line(D("1000"), account=acc(books, "1110")), Line(D("-1000"), account=acc(books, "3100"))])
    post(system_ctx, books, [Line(D("300"), account=acc(books, "1110")), Line(D("-300"), account=acc(books, "4200"))])
    post(system_ctx, books, [Line(D("120"), account=acc(books, "5430")), Line(D("-120"), account=acc(books, "1110"))])
    tb = reports.trial_balance(books.pk, fiscal_year.start_date, fiscal_year.end_date)
    assert tb["balanced"] and tb["totals"]["debit"] == D("1420")
    pl = reports.profit_and_loss(books.pk, fiscal_year.start_date, fiscal_year.end_date)
    assert pl["net_profit"] == D("180")
    bs = reports.balance_sheet(books.pk, fiscal_year.end_date)
    assert bs["balanced"] and bs["totals"]["asset"] == D("1180")
    ledger = reports.account_ledger(acc(books, "1110"), fiscal_year.start_date, fiscal_year.end_date)
    assert ledger["closing"] == D("1180") and len(ledger["lines"]) == 3


def test_manual_journal_maker_checker(make_user, grant, ctx, books):
    maker, checker = make_user(), make_user()
    grant(maker, ["finance.journal_entry.create", "finance.journal_entry.post"], books)
    grant(checker, ["finance.journal_entry.post"], books)
    lines = [{"amount": D("75"), "account": acc(books, "5430")}, {"amount": D("-75"), "account": acc(books, "1100")}]
    entry = services.create_manual_journal(
        ctx(maker), company=books, entry_date=timezone.localdate(), narration="Petty cash", lines=lines
    )
    assert entry.status == "draft"
    with pytest.raises(AuthorizationDenied):
        services.post_manual_journal(ctx(maker), entry)
    services.post_manual_journal(ctx(checker), entry)
    assert gl_balance(books, "5430") == D("75")


def test_determination_most_specific_wins(books, system_ctx):
    special = Account.objects.create(company=books, code="1399", name="RM at WIP", account_type="asset")
    AccountDetermination.objects.create(
        company=books, key="inventory", posting_group="RM", warehouse_type="wip", account=special
    )
    assert resolve_account(books.pk, "inventory", "RM", "wip") == special
    assert resolve_account(books.pk, "inventory", "FG", "wip").code == "1310"
    assert resolve_account(books.pk, "inventory", "RM", "raw_material").code == "1300"


def test_future_dated_posting_needs_open_fiscal_year(system_ctx, books):
    far = timezone.localdate() + timedelta(days=800)
    with pytest.raises(BusinessRuleViolation):
        post(
            system_ctx,
            books,
            [Line(D("1"), account=acc(books, "1110")), Line(D("-1"), account=acc(books, "3100"))],
            on=far,
        )
