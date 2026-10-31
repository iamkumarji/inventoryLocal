from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.approvals import services as approvals
from apps.approvals.models import ApprovalLevel, ApprovalMatrix, ApprovalRequest
from apps.authorization.models import ApprovalLimit
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, MFARequired
from apps.expenses import services
from apps.expenses.models import ExpenseCategory, FuelLog
from apps.hr.tests.factories import enable_modules, enable_policy, make_employee
from conftest import gl_balance

pytestmark = [pytest.mark.django_db, pytest.mark.req("EXP-001")]
D = Decimal
TODAY = timezone.localdate


@pytest.fixture(autouse=True)
def modules(db):
    enable_modules("module.hr", "module.expenses", "module.finance")


@pytest.fixture
def setup(org, books, make_department, make_user, make_role, grant, system_ctx):
    dept = make_department(books, code="OPS")
    other = make_department(books, code="ADMIN")
    users = {n: make_user(full_name=n.title()) for n in ("driver", "manager", "payer", "clerk")}
    for name in ("driver", "manager"):
        grant(users[name], ["expenses.expense_claim.create", "expenses.employee_advance.create"], dept)
    approver_role = make_role(
        [
            "expenses.expense_claim.approve",
            "expenses.expense_claim.reject",
            "expenses.expense_claim.read",
            "expenses.employee_advance.approve",
            "expenses.employee_advance.read",
        ]
    )
    for doc in ("expenses.expense_claim", "expenses.employee_advance"):
        ApprovalLimit.objects.create(
            organization=org, role=approver_role, document_type=doc, currency="INR", max_amount=D("50000")
        )
    grant(users["manager"], [], dept, role=approver_role)
    grant(
        users["payer"],
        [
            "expenses.expense_claim.pay",
            "expenses.expense_claim.read",
            "expenses.employee_advance.pay",
            "expenses.employee_advance.read",
        ],
        books,
    )
    grant(users["clerk"], ["expenses.fuel_log.create", "expenses.fuel_log.read"], books)
    enable_policy(org, "allow_own_expense_claim")
    employees = {
        "driver": make_employee(system_ctx, books, dept, "D001", user=users["driver"]),
        "manager": make_employee(system_ctx, books, dept, "M001", user=users["manager"]),
        "outsider": make_employee(system_ctx, books, other, "A001"),
    }
    categories = {
        "fuel": ExpenseCategory.objects.create(
            company=books,
            code="FUEL",
            name="Fuel",
            gl_key="fuel_expense",
            requires_vehicle=True,
            receipt_required_above=D("500"),
        ),
        "travel": ExpenseCategory.objects.create(
            company=books,
            code="TRAVEL",
            name="Travel",
            gl_key="travel_expense",
            per_claim_limit=D("10000"),
            receipt_required_above=D("1000"),
        ),
        "general": ExpenseCategory.objects.create(company=books, code="GEN", name="General"),
    }
    return {**users, "emp": employees, "cat": categories, "dept": dept}


def fuel_line(cat, amount="2000", odometer="10500", litres="20", receipt="DOC-1", on=None):
    return {
        "category": cat,
        "expense_date": on or TODAY(),
        "description": "Diesel",
        "amount": D(amount),
        "receipt_reference": receipt,
        "vehicle_registration": "mh 12 ab 1234",
        "odometer": D(odometer) if odometer else None,
        "litres": D(litres),
    }


def line(cat, amount, receipt="", description="Expense"):
    return {
        "category": cat,
        "expense_date": TODAY(),
        "description": description,
        "amount": D(amount),
        "receipt_reference": receipt,
    }


def test_expense_to_payment_with_advance_settlement(setup, ctx, books):
    driver, manager, payer = ctx(setup["driver"]), ctx(setup["manager"]), ctx(setup["payer"])
    cat = setup["cat"]

    advance = services.request_advance(driver, employee=setup["emp"]["driver"], amount=D("3000"), purpose="Trip")
    advance = services.decide_advance(manager, advance, approve=True)
    advance = services.pay_advance(payer, advance, paid_on=TODAY(), bank_reference="NEFT-ADV-1")
    assert advance.status == "paid"
    assert gl_balance(books, "1450") == D("3000") and gl_balance(books, "1110") == D("-3000")

    claim = services.create_claim(
        driver,
        employee=setup["emp"]["driver"],
        claim_date=TODAY(),
        purpose="Delivery run to Pune",
        advance=advance,
        lines=[
            fuel_line(cat["fuel"]),
            line(cat["travel"], "1500", "DOC-2", "Toll and parking"),
            line(cat["general"], "300"),
        ],
    )
    assert claim.amount == D("3800") and claim.status == "draft"
    claim = services.submit_claim(driver, claim)
    claim = services.decide_claim(manager, claim, approve=True)
    claim.refresh_from_db()
    assert (claim.status, claim.advance_settled, claim.net_payable) == ("approved", D("3000"), D("800"))
    assert gl_balance(books, "5400") == D("2000")
    assert gl_balance(books, "5410") == D("1500")
    assert gl_balance(books, "5430") == D("300")
    assert gl_balance(books, "1450") == 0  # advance fully settled
    assert gl_balance(books, "2500") == D("-800")
    advance.refresh_from_db()
    assert (advance.status, advance.settled_amount) == ("settled", D("3000"))
    log = FuelLog.objects.get(claim_line__claim=claim)
    assert (log.vehicle_registration, log.odometer, log.litres, log.amount) == (
        "MH12AB1234",
        D("10500"),
        D("20"),
        D("2000"),
    )

    with pytest.raises(MFARequired):
        services.mark_paid(ctx(setup["payer"], mfa=False), claim, paid_on=TODAY(), bank_reference="NEFT-1")
    claim = services.mark_paid(payer, claim, paid_on=TODAY(), bank_reference="NEFT-1")
    assert claim.status == "paid" and claim.paid_by == setup["payer"]
    assert gl_balance(books, "2500") == 0
    assert gl_balance(books, "1110") == D("-3800")


def test_claim_settles_partially_when_the_advance_exceeds_the_claim(setup, ctx, books):
    driver, manager, payer = ctx(setup["driver"]), ctx(setup["manager"]), ctx(setup["payer"])
    advance = services.request_advance(driver, employee=setup["emp"]["driver"], amount=D("5000"), purpose="Trip")
    advance = services.pay_advance(
        payer, services.decide_advance(manager, advance, approve=True), paid_on=TODAY(), bank_reference="NEFT-ADV-2"
    )
    claim = services.create_claim(
        driver,
        employee=setup["emp"]["driver"],
        claim_date=TODAY(),
        purpose="Hotel",
        advance=advance,
        lines=[line(setup["cat"]["general"], "1200")],
    )
    services.decide_claim(manager, services.submit_claim(driver, claim), approve=True)
    claim.refresh_from_db()
    advance.refresh_from_db()
    assert (claim.advance_settled, claim.net_payable) == (D("1200"), 0)
    assert (advance.status, advance.outstanding) == ("paid", D("3800"))
    assert gl_balance(books, "1450") == D("3800") and gl_balance(books, "2500") == 0
    claim = services.mark_paid(payer, claim, paid_on=TODAY(), bank_reference="NIL")
    assert claim.status == "paid" and claim.payment_journal is None  # nothing left to pay


def test_nobody_approves_or_pays_their_own_claim(setup, ctx, grant, books):
    manager = ctx(setup["manager"])
    own = services.create_claim(
        manager,
        employee=setup["emp"]["manager"],
        claim_date=TODAY(),
        purpose="Lunch",
        lines=[line(setup["cat"]["general"], "400")],
    )
    own = services.submit_claim(manager, own)
    with pytest.raises(AuthorizationDenied) as exc:
        services.decide_claim(manager, own, approve=True)
    assert exc.value.reason == "self_approval"

    # A claimant who also holds the pay permission can't pay their own claim (maker-checker).
    grant(setup["driver"], ["expenses.expense_claim.pay", "expenses.expense_claim.read"], books)
    claim = services.create_claim(
        ctx(setup["driver"]),
        employee=setup["emp"]["driver"],
        claim_date=TODAY(),
        purpose="Parking",
        lines=[line(setup["cat"]["general"], "100")],
    )
    claim = services.decide_claim(manager, services.submit_claim(ctx(setup["driver"]), claim), approve=True)
    with pytest.raises(AuthorizationDenied) as exc:
        services.mark_paid(ctx(setup["driver"]), claim, paid_on=TODAY(), bank_reference="SELF")
    assert exc.value.reason == "maker_checker"


def test_category_limits_and_receipts_are_enforced_on_submit(setup, ctx):
    driver = ctx(setup["driver"])
    cat = setup["cat"]
    claim = services.create_claim(
        driver,
        employee=setup["emp"]["driver"],
        claim_date=TODAY(),
        purpose="Conference",
        lines=[
            line(cat["travel"], "6000", "DOC-9", "Flight"),
            line(cat["travel"], "5000", "", "Train"),  # over the receipt threshold, no receipt
            fuel_line(cat["fuel"], amount="800", receipt="", odometer=None),
        ],
    )
    with pytest.raises(BusinessRuleViolation) as exc:
        services.submit_claim(driver, claim)
    found = {(e["line"], e["field"]) for e in exc.value.meta["errors"]}
    assert found == {(2, "receipt_reference"), (3, "receipt_reference"), (3, "odometer"), (None, "amount")}
    claim.refresh_from_db()
    assert claim.status == "draft"

    # Limits are data: raising the category limit and attaching receipts makes the same claim valid.
    cat["travel"].per_claim_limit = D("20000")
    cat["travel"].save()
    claim = services.update_claim(
        driver,
        claim,
        {
            "lines": [
                line(cat["travel"], "6000", "DOC-9"),
                line(cat["travel"], "5000", "DOC-10"),
                fuel_line(cat["fuel"], amount="800"),
            ]
        },
        claim.version,
    )
    assert services.submit_claim(driver, claim).status == "submitted"


def test_claim_approval_respects_the_approval_limit(setup, ctx, org):
    limit = ApprovalLimit.objects.get(document_type="expenses.expense_claim")
    limit.max_amount = D("1000")
    limit.save()
    claim = services.create_claim(
        ctx(setup["driver"]),
        employee=setup["emp"]["driver"],
        claim_date=TODAY(),
        purpose="Tools",
        lines=[line(setup["cat"]["general"], "1500")],
    )
    claim = services.submit_claim(ctx(setup["driver"]), claim)
    with pytest.raises(AuthorizationDenied) as exc:
        services.decide_claim(ctx(setup["manager"]), claim, approve=True)
    assert exc.value.reason == "approval_limit"


def test_odometer_must_increase_per_vehicle(setup, ctx):
    clerk = ctx(setup["clerk"])
    driver = setup["emp"]["driver"]
    services.record_fuel(
        clerk,
        driver=driver,
        vehicle_registration="MH12AB1234",
        log_date=TODAY() - timedelta(5),
        odometer=D("10000"),
        litres=D("30"),
        rate=D("95.50"),
    )
    services.record_fuel(
        clerk,
        driver=driver,
        vehicle_registration="MH-14-XY-9",
        log_date=TODAY(),
        odometer=D("500"),
        litres=D("10"),
        rate=D("95"),
    )  # another vehicle: independent
    with pytest.raises(BusinessRuleViolation, match="previous reading"):
        services.record_fuel(
            clerk,
            driver=driver,
            vehicle_registration="mh12ab1234",
            log_date=TODAY(),
            odometer=D("9000"),
            litres=D("10"),
            rate=D("95"),
        )
    with pytest.raises(BusinessRuleViolation, match="later reading"):  # back-dated above a later reading
        services.record_fuel(
            clerk,
            driver=driver,
            vehicle_registration="MH12AB1234",
            log_date=TODAY() - timedelta(10),
            odometer=D("10100"),
            litres=D("10"),
            rate=D("95"),
        )
    log = services.record_fuel(
        clerk,
        driver=driver,
        vehicle_registration="MH12AB1234",
        log_date=TODAY(),
        odometer=D("10450"),
        litres=D("20"),
        rate=D("95.50"),
    )
    assert log.amount == D("1910")
    # A fuel claim line below the last reading fails the policy check on submit.
    claim = services.create_claim(
        ctx(setup["driver"]),
        employee=driver,
        claim_date=TODAY(),
        purpose="Fuel",
        lines=[fuel_line(setup["cat"]["fuel"], odometer="10400")],
    )
    with pytest.raises(BusinessRuleViolation) as exc:
        services.submit_claim(ctx(setup["driver"]), claim)
    assert exc.value.meta["errors"][0]["field"] == "odometer"


def test_employees_cannot_file_for_colleagues(setup, ctx):
    with pytest.raises(AuthorizationDenied):
        services.create_claim(
            ctx(setup["driver"]),
            employee=setup["emp"]["manager"],
            claim_date=TODAY(),
            purpose="Not mine",
            lines=[line(setup["cat"]["general"], "10")],
        )
    with pytest.raises(AuthorizationDenied):  # outside the department scope of the create grant
        services.request_advance(ctx(setup["driver"]), employee=setup["emp"]["outsider"], amount=D("10"), purpose="x")


def test_claim_via_approval_route_posts_on_final_approval(setup, ctx, org, make_role, grant, make_user, books):
    route_role = make_role(["expenses.expense_claim.approve", "expenses.expense_claim.read"])
    ApprovalLimit.objects.create(
        organization=org, role=route_role, document_type="expenses.expense_claim", currency="INR", max_amount=D("10000")
    )
    head = make_user(full_name="Head")
    grant(head, [], setup["dept"], role=route_role)
    matrix = ApprovalMatrix.objects.create(organization=org, document_type="expenses.expense_claim", name="Claims")
    ApprovalLevel.objects.create(matrix=matrix, sequence=1, name="Department head", role=route_role)
    claim = services.create_claim(
        ctx(setup["driver"]),
        employee=setup["emp"]["driver"],
        claim_date=TODAY(),
        purpose="Cab",
        lines=[line(setup["cat"]["travel"], "700")],
    )
    services.submit_claim(ctx(setup["driver"]), claim)
    approvals.decide(ctx(head), ApprovalRequest.objects.get(document_id=claim.pk), approve=True)
    claim.refresh_from_db()
    assert claim.status == "approved" and claim.approval_journal_id is not None
    assert gl_balance(books, "5410") == D("700") and gl_balance(books, "2500") == D("-700")


def test_claim_api_self_service(setup, api_for):
    client = api_for(setup["driver"])
    response = client.post(
        "/api/v1/expenses/claims/",
        {
            "claim_date": str(TODAY()),
            "purpose": "Client visit",
            "lines": [
                {
                    "category": str(setup["cat"]["general"].pk),
                    "expense_date": str(TODAY()),
                    "description": "Snacks",
                    "amount": "250.00",
                }
            ],
        },
        format="json",
    )
    assert response.status_code == 201, response.json()
    body = response.json()
    assert body["employee"] == str(setup["emp"]["driver"].pk) and body["amount"] == "250.0000"
    submitted = client.post(
        f"/api/v1/expenses/claims/{body['id']}/submit/", {"version": body["version"]}, format="json"
    )
    assert submitted.status_code == 200 and submitted.json()["status"] == "submitted"
    stale = client.post(f"/api/v1/expenses/claims/{body['id']}/submit/", {"version": body["version"]}, format="json")
    assert stale.status_code == 409
    mine = client.get("/api/v1/expenses/my/claims/").json()
    assert [c["id"] for c in mine] == [body["id"]]
    pay = api_for(setup["payer"]).post(
        f"/api/v1/expenses/claims/{body['id']}/pay/", {"paid_on": str(TODAY()), "bank_reference": "X"}, format="json"
    )
    assert pay.status_code == 400  # Idempotency-Key is required for payments


def test_rejected_claim_shows_the_reason_and_lines_only_take_own_org_categories(setup, api_for, make_company):
    from apps.organization.models import Organization

    client = api_for(setup["driver"])
    stranger = Organization.objects.create(code="OTHER", name="Other Org")
    foreign = ExpenseCategory.objects.create(company=make_company(organization=stranger), code="FOR", name="Foreign")
    body = {
        "claim_date": str(TODAY()),
        "purpose": "Client visit",
        "lines": [{"category": str(foreign.pk), "expense_date": str(TODAY()), "description": "Taxi", "amount": "300"}],
    }
    refused = client.post("/api/v1/expenses/claims/", body, format="json")
    assert refused.status_code == 400 and refused.json()["errors"][0]["field"] == "lines.0.category"

    body["lines"][0]["category"] = str(setup["cat"]["general"].pk)
    claim = client.post("/api/v1/expenses/claims/", body, format="json").json()
    assert claim["rejection_reason"] == ""
    claim = client.post(f"/api/v1/expenses/claims/{claim['id']}/submit/", {"version": claim["version"]}, format="json")
    claim = claim.json()
    decided = api_for(setup["manager"]).post(
        f"/api/v1/expenses/claims/{claim['id']}/decide/",
        {"approve": False, "comment": "Attach the taxi bill.", "version": claim["version"]},
        format="json",
    )
    assert decided.status_code == 200 and decided.json()["rejection_reason"] == "Attach the taxi bill."
    mine = client.get("/api/v1/expenses/my/claims/").json()
    assert mine[0]["status"] == "rejected" and mine[0]["rejection_reason"] == "Attach the taxi bill."
    # Once resubmitted the old reason no longer shows.
    again = client.post(
        f"/api/v1/expenses/claims/{claim['id']}/submit/", {"version": mine[0]["version"]}, format="json"
    )
    assert again.status_code == 200 and again.json()["rejection_reason"] == ""
