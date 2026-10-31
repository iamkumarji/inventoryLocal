"""Finance API inputs accept only the caller's own records: another organization's accounts, partners, bank
accounts or fiscal years read as "does not exist" (multi-tenancy), while the caller's own still work."""

from datetime import date

import pytest

from apps.core.models import FeatureFlag
from apps.finance.models import Account, BankAccount
from apps.finance.services import install_chart
from apps.organization.models import Company, Organization
from apps.organization.services import create_fiscal_year
from apps.partners.models import Partner

pytestmark = [pytest.mark.django_db, pytest.mark.req("ADM-010")]
TODAY = date.today()
FY_START = TODAY.year - (1 if TODAY.month < 4 else 0)


@pytest.fixture(autouse=True)
def modules(db):
    for key in ("module.finance", "module.partners"):
        FeatureFlag.objects.create(key=key, enabled_default=True)


@pytest.fixture
def foreign(system_ctx):
    """Another tenant with its own books, bank account and supplier."""
    other = Organization.objects.create(code="OTHERORG", name="Other Org")
    company = Company.objects.create(organization=other, code="OT1", legal_name="Other Industries Pvt Ltd")
    fiscal_year = create_fiscal_year(system_ctx, company=company, start_year=FY_START)
    install_chart(system_ctx, company)
    bank = BankAccount.objects.create(
        company=company, account=Account.objects.get(company=company, code="1110"), bank_name="Other bank"
    )
    partner = Partner.objects.create(
        organization=other, code="OTHER-SUP", name="Other supplier", is_supplier=True, gst_registration="unregistered"
    )
    return {"company": company, "fy": fiscal_year, "bank": bank, "partner": partner}


def error_fields(response) -> set[str]:
    return {e.get("field") or "" for e in response.json().get("errors", [])}


@pytest.fixture
def client(books, make_user, grant, api_for):
    user = make_user()
    grant(
        user,
        [
            f"finance.{resource}.{action}"
            for resource in ("journal_entry", "payment", "budget", "account")
            for action in ("create", "read")
        ],
        books,
    )
    return api_for(user, company=books)


def test_journal_lines_refuse_another_tenants_account(client, books, foreign):
    theirs = Account.objects.get(company=foreign["company"], code="5420")
    ours = {code: str(Account.objects.get(company=books, code=code).pk) for code in ("5420", "1100")}

    def journal(debit_account):
        return client.post(
            "/api/v1/finance/journal-entries/",
            {
                "company": str(books.pk),
                "entry_date": TODAY.isoformat(),
                "narration": "Tenant check",
                "lines": [
                    {"account": debit_account, "debit": "100.00", "credit": "0"},
                    {"account": ours["1100"], "debit": "0", "credit": "100.00"},
                ],
            },
            format="json",
        )

    refused = journal(str(theirs.pk))
    assert refused.status_code == 400, refused.content
    assert any("account" in f for f in error_fields(refused)), refused.content
    accepted = journal(ours["5420"])
    assert accepted.status_code == 201, accepted.content


def test_payment_refuses_another_tenants_partner_and_bank_account(client, books, foreign):
    response = client.post(
        "/api/v1/finance/payments/",
        {
            "company": str(books.pk),
            "kind": "supplier_payment",
            "partner": str(foreign["partner"].pk),
            "bank_account": str(foreign["bank"].pk),
            "payment_date": TODAY.isoformat(),
            "mode": "neft",
            "amount": "100.00",
            "allocations": [],
        },
        format="json",
    )
    assert response.status_code == 400, response.content
    assert {"partner", "bank_account"} <= error_fields(response), response.content


def test_budget_and_account_refuse_another_tenants_fiscal_year_and_parent(client, books, foreign):
    budget = client.post(
        "/api/v1/finance/budgets/",
        {
            "company": str(books.pk),
            "fiscal_year": str(foreign["fy"].pk),
            "name": "Sneaky budget",
            "lines": [
                {
                    "account": str(Account.objects.get(company=foreign["company"], code="5420").pk),
                    "period_no": 1,
                    "amount": "10.00",
                }
            ],
        },
        format="json",
    )
    assert budget.status_code == 400, budget.content
    assert "fiscal_year" in error_fields(budget), budget.content
    assert any("account" in f for f in error_fields(budget)), budget.content

    account = client.post(
        "/api/v1/finance/accounts/",
        {
            "company": str(books.pk),
            "code": "1199",
            "name": "Sneaky child",
            "account_type": "asset",
            "sub_type": "general",
            "parent": str(Account.objects.get(company=foreign["company"], code="1000").pk),
        },
        format="json",
    )
    assert account.status_code == 400, account.content
    assert "parent" in error_fields(account), account.content


def test_bank_match_accepts_own_journal_line_without_a_warehouse(books, make_user, grant, api_for, system_ctx):
    """Regression: the generic tenant boundary placed journal lines by their optional warehouse, so a bank
    or expense line (no warehouse) was "not found" and could never be matched by hand."""
    from decimal import Decimal

    from apps.core.ids import uuid7
    from apps.finance.models import BankStatementLine
    from apps.finance.posting import Line, post_journal

    bank_ledger = Account.objects.get(company=books, code="1110")
    bank = BankAccount.objects.create(company=books, account=bank_ledger, bank_name="HDFC")
    entry = post_journal(
        system_ctx,
        company_id=books.pk,
        entry_date=TODAY,
        lines=[
            Line(amount=Decimal("150"), account=Account.objects.get(company=books, code="5600")),
            Line(amount=Decimal("-150"), account=bank_ledger),
        ],
        narration="Bank charges",
        source_module="test",
    )
    bank_line = entry.lines.get(account=bank_ledger)
    assert bank_line.warehouse_id is None
    statement = BankStatementLine.objects.create(
        company=books,
        bank_account=bank,
        import_batch=uuid7(),
        txn_date=TODAY,
        description="Charges",
        amount=Decimal("-150"),
    )
    user = make_user()
    grant(user, ["finance.bank_account.read", "finance.bank_account.update"], books)
    response = api_for(user, company=books).post(
        f"/api/v1/finance/bank-accounts/{bank.pk}/match/",
        {"statement_line": str(statement.pk), "journal_line": str(bank_line.pk)},
        format="json",
    )
    assert response.status_code == 200, response.content
    assert response.json()["status"] == "matched"


def test_references_stay_within_the_active_company(client, books, make_company, system_ctx):
    """Same organization, another company: its accounts can't be used in this company's books either."""
    sister = make_company("SIS")
    create_fiscal_year(system_ctx, company=sister, start_year=FY_START)
    install_chart(system_ctx, sister)
    response = client.post(
        "/api/v1/finance/accounts/",
        {
            "company": str(books.pk),
            "code": "1198",
            "name": "Child under the sister company's heading",
            "account_type": "asset",
            "sub_type": "general",
            "parent": str(Account.objects.get(company=sister, code="1000").pk),
        },
        format="json",
    )
    assert response.status_code == 400, response.content
    assert "parent" in error_fields(response), response.content
