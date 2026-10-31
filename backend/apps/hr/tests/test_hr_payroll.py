import calendar
from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.approvals import services as approvals
from apps.approvals.models import ApprovalLevel, ApprovalMatrix, ApprovalRequest
from apps.authorization.models import ApprovalLimit
from apps.core.crypto import decrypt_str
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, MFARequired
from apps.finance.models import CostCenter, JournalLine
from apps.hr import services
from apps.hr.models import AttendanceRecord, LeaveBalance, LeaveRequest, LeaveType, Payslip, SalaryComponent
from conftest import gl_balance

from .factories import enable_modules, enable_policy, make_employee

pytestmark = [pytest.mark.django_db, pytest.mark.req("HR-001")]
D = Decimal
TODAY = timezone.localdate


def money(x):
    return D(x).quantize(D("0.01"))


@pytest.fixture(autouse=True)
def modules(db):
    enable_modules("module.hr", "module.finance")


@pytest.fixture
def depts(books, make_department):
    return {"prod": make_department(books, code="PROD"), "sales": make_department(books, code="SALES")}


@pytest.fixture
def staff(org, books, depts, make_user, grant, make_role, system_ctx):
    users = {n: make_user(full_name=n.title()) for n in ("hr", "officer", "approver", "manager", "worker", "seller")}
    grant(
        users["hr"],
        [
            "hr.employee.create",
            "hr.employee.read",
            "hr.employee.update",
            "hr.attendance.create",
            "hr.attendance.read",
            "hr.attendance.update",
            "hr.leave_type.create",
            "hr.leave_type.read",
            "hr.leave_balance.create",
            "hr.leave_balance.update",
            "hr.leave_balance.read",
            "hr.leave_request.create",
            "hr.leave_request.read",
            "hr.leave_request.update",
            "hr.payslip.read",
            "hr.payroll_run.read",
        ],
        books,
    )
    grant(
        users["officer"],
        [
            "hr.salary.create",
            "hr.salary.read",
            "hr.salary.update",
            "hr.salary_structure.create",
            "hr.salary_structure.read",
            "hr.payroll_run.create",
            "hr.payroll_run.read",
            "hr.payroll_run.update",
            "hr.payroll_run.approve",  # holds approve too: the self-approval guard must still stop them
            "hr.payroll_run.post",
            "hr.payslip.read",
        ],
        books,
    )
    approver_role = make_role(["hr.payroll_run.approve", "hr.payroll_run.reject", "hr.payroll_run.read"])
    ApprovalLimit.objects.create(
        organization=org, role=approver_role, document_type="hr.payroll_run", currency="INR", max_amount=D("1000000")
    )
    grant(users["approver"], [], books, role=approver_role)
    # Department-scoped leave approver who is also an employee of that department.
    grant(
        users["manager"],
        [
            "hr.leave_request.approve",
            "hr.leave_request.reject",
            "hr.leave_request.read",
            "hr.leave_request.create",
            "hr.leave_request.update",
        ],
        depts["prod"],
    )
    grant(users["worker"], ["hr.leave_request.create"], depts["prod"])
    employees = {
        "manager": make_employee(system_ctx, books, depts["prod"], "E001", user=users["manager"]),
        "worker": make_employee(system_ctx, books, depts["prod"], "E002", user=users["worker"]),
        "seller": make_employee(system_ctx, books, depts["sales"], "E003", user=users["seller"]),
    }
    return {**users, "emp": employees}


@pytest.fixture
def casual(books):
    return LeaveType.objects.create(company=books, code="CL", name="Casual leave", is_paid=True, annual_quota=D("12"))


def day(n: int) -> date:
    today = TODAY()
    return date(today.year, today.month, n)


# --- Employees ----------------------------------------------------------------------------------------


def test_sensitive_fields_are_encrypted_and_never_served_in_full(staff, depts, api_for, books):
    client = api_for(staff["hr"], company=books)
    response = client.post(
        "/api/v1/hr/employees/",
        {
            "code": "E100",
            "full_name": "Asha Rao",
            "department": str(depts["prod"].pk),
            "date_of_joining": "2024-04-01",
            "pan": "abcde1234f",
            "bank_account_number": "001234567890",
            "aadhaar_last4": "4321",
        },
        format="json",
    )
    assert response.status_code == 201, response.json()
    body = response.json()
    assert {"pan", "bank_account_number", "aadhaar_last4", "pan_encrypted"}.isdisjoint(body)
    assert body["bank_account_masked"] == "XXXX7890" and "1234F" not in body["pan_masked"]
    assert body["aadhaar_masked"] == "XXXX-XXXX-XX21"
    from apps.hr.models import Employee

    stored = Employee.objects.get(pk=body["id"])
    assert "ABCDE1234F" not in stored.pan_encrypted and decrypt_str(stored.pan_encrypted) == "ABCDE1234F"
    listed = client.get("/api/v1/hr/employees/").json()["results"]
    assert "001234567890" not in str(listed) and "ABCDE1234F" not in str(listed)
    bad = client.patch(f"/api/v1/hr/employees/{body['id']}/", {"pan": "123", "version": body["version"]}, format="json")
    assert bad.status_code == 400 and bad.json()["errors"][0]["field"] == "pan"
    ok = client.patch(
        f"/api/v1/hr/employees/{body['id']}/", {"designation": "Fitter", "version": body["version"]}, format="json"
    )
    assert ok.status_code == 200 and ok.json()["designation"] == "Fitter" and ok.json()["version"] == 2
    stale = client.patch(
        f"/api/v1/hr/employees/{body['id']}/", {"designation": "X", "version": body["version"]}, format="json"
    )
    assert stale.status_code == 409


def test_linking_a_user_sets_subject_employee_id(staff):
    assert staff["worker"].employee_id == staff["emp"]["worker"].pk


# --- Attendance import ---------------------------------------------------------------------------------


def test_attendance_import_is_all_or_nothing_with_row_errors(staff, ctx, books):
    csv_text = "\n".join(
        [
            "employee_code,date,status,check_in,check_out",
            f"E002,{day(1)},present,09:00,18:00",
            f"E999,{day(1)},present,,",
            f"E002,{day(2)},sleeping,,",
            f"E002,{day(1)},absent,,",
            f"E003,{day(3)},present,18:00,09:00",
        ]
    )
    with pytest.raises(BusinessRuleViolation) as exc:
        services.import_attendance(ctx(staff["hr"]), company=books, csv_text=csv_text)
    rows = {(e["row"], e["field"]) for e in exc.value.meta["errors"]}
    assert rows == {(3, "employee_code"), (4, "status"), (5, "date"), (6, "check_out")}
    assert AttendanceRecord.objects.count() == 0

    ok = "employee_code,date,status\n" + "\n".join(f"E002,{day(n)},present" for n in (1, 2))
    assert services.import_attendance(ctx(staff["hr"]), company=books, csv_text=ok) == {
        "rows": 2,
        "created": 2,
        "updated": 0,
    }
    with pytest.raises(BusinessRuleViolation):
        services.import_attendance(ctx(staff["hr"]), company=books, csv_text=ok)  # already recorded
    again = services.import_attendance(ctx(staff["hr"]), company=books, csv_text=ok, overwrite=True)
    assert again["updated"] == 2


def test_attendance_import_rejects_employees_outside_the_callers_scope(staff, ctx, books, depts, grant, make_user):
    clerk = make_user()
    grant(clerk, ["hr.attendance.create"], depts["prod"])
    csv_text = f"employee_code,date,status\nE003,{day(1)},present"  # E003 is in sales
    with pytest.raises(BusinessRuleViolation) as exc:
        services.import_attendance(ctx(clerk), company=books, csv_text=csv_text)
    assert exc.value.meta["errors"][0]["field"] == "employee_code"


# --- Leave ---------------------------------------------------------------------------------------------------


def test_leave_approval_deducts_balance_and_marks_attendance(staff, ctx, casual, system_ctx, api_for):
    worker = staff["emp"]["worker"]
    services.allocate_leave(ctx(staff["hr"]), employee=worker, leave_type=casual, year=TODAY().year)
    leave = services.create_leave_request(
        ctx(staff["worker"]), employee=worker, leave_type=casual, from_date=day(10), to_date=day(12)
    )
    assert leave.days == D("3")  # calendar days, inclusive
    with pytest.raises(AuthorizationDenied):
        services.submit_leave_request(ctx(staff["worker"]), leave)  # no update grant and no owner policy yet
    enable_policy(staff["worker"].organization, "allow_own_leave_request")
    leave = services.submit_leave_request(ctx(staff["worker"]), leave)
    assert leave.status == "submitted"

    with pytest.raises(AuthorizationDenied):  # sales manager scope doesn't cover production
        services.decide_leave_request(ctx(staff["seller"]), leave, approve=True)
    leave = services.decide_leave_request(ctx(staff["manager"]), leave, approve=True)
    assert leave.status == "approved" and leave.approved_by == staff["manager"]
    balance = LeaveBalance.objects.get(employee=worker, leave_type=casual)
    assert (balance.used, balance.available) == (D("3"), D("9"))
    marked = AttendanceRecord.objects.filter(employee=worker, status="leave", leave_type=casual)
    assert sorted(r.date for r in marked) == [day(10), day(11), day(12)]
    services.allocate_leave(ctx(staff["hr"]), employee=staff["emp"]["seller"], leave_type=casual, year=TODAY().year)
    seller_leave = services.create_leave_request(
        ctx(staff["hr"]), employee=staff["emp"]["seller"], leave_type=casual, from_date=day(1), to_date=day(1)
    )
    listed = api_for(staff["manager"]).get("/api/v1/hr/leave-requests/").json()["results"]
    assert [r["id"] for r in listed] == [str(leave.pk)]  # department scope: production only
    assert str(seller_leave.pk) in {
        r["id"] for r in api_for(staff["hr"]).get("/api/v1/hr/leave-requests/").json()["results"]
    }

    too_long = services.create_leave_request(
        ctx(staff["hr"]), employee=worker, leave_type=casual, from_date=day(13), to_date=day(13)
    )
    LeaveBalance.objects.filter(pk=balance.pk).update(allocated=D("3"))  # nothing left
    with pytest.raises(BusinessRuleViolation, match="available"):
        services.submit_leave_request(ctx(staff["hr"]), too_long)
    with pytest.raises(BusinessRuleViolation, match="covers"):
        services.create_leave_request(
            ctx(staff["hr"]), employee=worker, leave_type=casual, from_date=day(11), to_date=day(11)
        )


def test_nobody_approves_their_own_leave(staff, ctx, casual):
    manager = staff["emp"]["manager"]
    services.allocate_leave(ctx(staff["hr"]), employee=manager, leave_type=casual, year=TODAY().year)
    own = services.create_leave_request(
        ctx(staff["manager"]), employee=manager, leave_type=casual, from_date=day(5), to_date=day(6)
    )
    own = services.submit_leave_request(ctx(staff["manager"]), own)
    with pytest.raises(AuthorizationDenied) as exc:
        services.decide_leave_request(ctx(staff["manager"]), own, approve=True)
    assert exc.value.reason == "self_approval"

    # Filed and submitted by HR on the manager's behalf: still the manager's own leave.
    LeaveRequest.objects.filter(pk=own.pk).update(status="cancelled")
    by_hr = services.create_leave_request(
        ctx(staff["hr"]), employee=manager, leave_type=casual, from_date=day(7), to_date=day(7)
    )
    by_hr = services.submit_leave_request(ctx(staff["hr"]), by_hr)
    with pytest.raises(AuthorizationDenied) as exc:
        services.decide_leave_request(ctx(staff["manager"]), by_hr, approve=True)
    assert exc.value.reason == "self_approval"
    assert LeaveBalance.objects.get(employee=manager).used == 0


def test_employees_cannot_file_leave_for_colleagues(staff, ctx, casual):
    with pytest.raises(AuthorizationDenied):
        services.create_leave_request(
            ctx(staff["worker"]), employee=staff["emp"]["manager"], leave_type=casual, from_date=day(5), to_date=day(5)
        )


def test_leave_via_approval_route_runs_the_completion_hook(staff, ctx, casual, org, make_role, grant, depts, make_user):
    route_role = make_role(["hr.leave_request.approve", "hr.leave_request.read"])
    head = make_user(full_name="Head")
    grant(head, [], depts["prod"], role=route_role)
    matrix = ApprovalMatrix.objects.create(organization=org, document_type="hr.leave_request", name="Leave route")
    ApprovalLevel.objects.create(matrix=matrix, sequence=1, name="Department head", role=route_role)
    worker = staff["emp"]["worker"]
    services.allocate_leave(ctx(staff["hr"]), employee=worker, leave_type=casual, year=TODAY().year)
    enable_policy(org, "allow_own_leave_request")
    leave = services.create_leave_request(
        ctx(staff["worker"]), employee=worker, leave_type=casual, from_date=day(20), to_date=day(21)
    )
    services.submit_leave_request(ctx(staff["worker"]), leave)
    request = ApprovalRequest.objects.get(document_id=leave.pk)
    with pytest.raises(BusinessRuleViolation):  # routed documents are decided in Approvals
        services.decide_leave_request(ctx(head), leave, approve=True)
    approvals.decide(ctx(head), request, approve=True)
    leave.refresh_from_db()
    assert leave.status == "approved"
    assert LeaveBalance.objects.get(employee=worker).used == D("2")


def test_my_leave_endpoint_files_and_submits_own_leave(staff, api_for, casual, ctx, org):
    worker = staff["emp"]["worker"]
    services.allocate_leave(ctx(staff["hr"]), employee=worker, leave_type=casual, year=TODAY().year)
    enable_policy(org, "allow_own_leave_request")
    client = api_for(staff["worker"])
    response = client.post(
        "/api/v1/hr/my/leave-requests/",
        {"leave_type": str(casual.pk), "from_date": str(day(14)), "to_date": str(day(15)), "reason": "Family"},
        format="json",
    )
    assert response.status_code == 201, response.json()
    assert response.json()["status"] == "submitted" and response.json()["days"] == "2.00"
    mine = client.get("/api/v1/hr/my/leave-requests/").json()
    assert [r["id"] for r in mine] == [response.json()["id"]]
    balances = client.get("/api/v1/hr/my/leave-balances/").json()
    assert balances[0]["available"] == "12.00"


# --- Payroll -------------------------------------------------------------------------------------------------


@pytest.fixture
def components(books):
    """TEMPLATE statutory set for tests only (rates/ceilings are illustrative data, not product defaults)."""

    def comp(code, kind, calc="fixed", **kw):
        return SalaryComponent.objects.create(company=books, code=code, name=code, kind=kind, calculation=calc, **kw)

    return {
        "BASIC": comp("BASIC", "earning", is_basic=True, sequence=10),
        "HRA": comp("HRA", "earning", "percent_of_basic", rate_pct=D("40"), sequence=20),
        "SPL": comp("SPL", "earning", sequence=30),
        "PF_EE": comp(
            "PF_EE", "deduction", "percent_of_basic", rate_pct=D("12"), wage_ceiling=D("15000"), is_statutory=True
        ),
        "PF_ER": comp(
            "PF_ER",
            "employer_contribution",
            "percent_of_basic",
            rate_pct=D("12"),
            wage_ceiling=D("15000"),
            is_statutory=True,
        ),
        "ESI_EE": comp(
            "ESI_EE", "deduction", "percent_of_gross", rate_pct=D("0.75"), gross_max=D("21000"), is_statutory=True
        ),
        "ESI_ER": comp(
            "ESI_ER",
            "employer_contribution",
            "percent_of_gross",
            rate_pct=D("3.25"),
            gross_max=D("21000"),
            is_statutory=True,
        ),
        "PT": comp("PT", "deduction", gross_min=D("10000"), prorate=False, is_statutory=True),
    }


@pytest.fixture
def payroll(staff, ctx, books, components, depts, casual):
    officer = ctx(staff["officer"])
    structure = services.create_structure(
        officer,
        company=books,
        code="STD",
        name="Standard",
        lines=[
            {"component": components["BASIC"]},
            {"component": components["HRA"]},
            {"component": components["SPL"], "amount": D("0")},
            {"component": components["PF_EE"]},
            {"component": components["PF_ER"]},
            {"component": components["ESI_EE"]},
            {"component": components["ESI_ER"]},
            {"component": components["PT"], "amount": D("200")},
        ],
    )
    start = date(TODAY().year, TODAY().month, 1)
    for key, basic, special in (("manager", "20000", "5000"), ("worker", "12000", "2000")):
        services.assign_salary(
            officer,
            employee=staff["emp"][key],
            structure=structure,
            effective_from=start - timedelta(days=60),
            lines=[
                {"component": components["BASIC"], "amount": D(basic)},
                {"component": components["SPL"], "amount": D(special)},
            ],
        )
    days = calendar.monthrange(start.year, start.month)[1]
    # Worker: paid leave on day 6 (approved), absent on 3-4, holiday on 5, present otherwise.
    worker = staff["emp"]["worker"]
    services.allocate_leave(ctx(staff["hr"]), employee=worker, leave_type=casual, year=start.year)
    leave = services.create_leave_request(
        ctx(staff["hr"]), employee=worker, leave_type=casual, from_date=day(6), to_date=day(6)
    )
    services.submit_leave_request(ctx(staff["hr"]), leave)
    services.decide_leave_request(ctx(staff["manager"]), leave, approve=True)
    rows = ["employee_code,date,status"]
    worker_status = {3: "absent", 4: "absent", 5: "holiday"}
    for n in range(1, days + 1):
        rows.append(f"E001,{day(n)},present")
        if n != 6:
            rows.append(f"E002,{day(n)},{worker_status.get(n, 'present')}")
    services.import_attendance(ctx(staff["hr"]), company=books, csv_text="\n".join(rows))
    cc = CostCenter.objects.create(company=books, code="CC-PROD", name="Production", department=depts["prod"])
    return {"structure": structure, "days": D(days), "cost_center": cc}


def expected_worker(days: Decimal) -> dict:
    ratio = (days - 2) / days
    basic, hra, spl = money(D("12000") * ratio), money(D("4800") * ratio), money(D("2000") * ratio)
    gross = basic + hra + spl
    pf = money(basic * D("0.12"))
    esi_ee, esi_er = money(gross * D("0.0075")), money(gross * D("0.0325"))
    deductions = pf + esi_ee + D("200")
    return {
        "gross": gross,
        "deductions": deductions,
        "employer": pf + esi_er,
        "net": gross - deductions,
        "basic": basic,
    }


def test_payroll_computes_prorates_and_posts_one_balanced_journal(staff, ctx, books, payroll, api_for):
    officer, approver = ctx(staff["officer"]), ctx(staff["approver"])
    run = services.create_payroll_run(officer, company=books, year=TODAY().year, month=TODAY().month)
    run = services.compute_payroll(officer, run)
    assert run.status == "computed" and run.employee_count == 2  # seller has no salary: skipped

    full = Payslip.objects.get(run=run, employee=staff["emp"]["manager"])
    assert (full.paid_days, full.lop_days) == (payroll["days"], 0)
    lines = {line.code: line.amount for line in full.lines.all()}
    # Full month: BASIC 20000, HRA 40% = 8000, SPL 5000; PF on the 15000 ceiling; ESI not applicable.
    assert lines == {
        "BASIC": D("20000"),
        "HRA": D("8000"),
        "SPL": D("5000"),
        "PF_EE": D("1800"),
        "PF_ER": D("1800"),
        "PT": D("200"),
    }
    assert (full.gross, full.total_deductions, full.employer_contributions, full.net_pay) == (
        D("33000"),
        D("2000"),
        D("1800"),
        D("31000"),
    )
    assert full.cost_center == payroll["cost_center"]

    part = Payslip.objects.get(run=run, employee=staff["emp"]["worker"])
    exp = expected_worker(payroll["days"])
    assert (part.present_days, part.paid_leave_days, part.holiday_days) == (payroll["days"] - 4, 1, 1)
    assert (part.paid_days, part.lop_days) == (payroll["days"] - 2, 2)
    assert part.lines.get(code="BASIC").amount == exp["basic"]
    assert (part.gross, part.total_deductions, part.employer_contributions, part.net_pay) == (
        exp["gross"],
        exp["deductions"],
        exp["employer"],
        exp["net"],
    )

    run = services.submit_payroll(officer, run)
    with pytest.raises(AuthorizationDenied) as exc:
        services.decide_payroll(officer, run, approve=True)  # submitted it: can't approve it
    assert exc.value.reason == "self_approval"
    with pytest.raises(MFARequired):
        services.decide_payroll(ctx(staff["approver"], mfa=False), run, approve=True)
    run = services.decide_payroll(approver, run, approve=True)

    response = api_for(staff["officer"]).post(
        f"/api/v1/hr/payroll-runs/{run.pk}/post/",
        {"version": run.version},
        format="json",
        HTTP_IDEMPOTENCY_KEY="pay-run-1",
    )
    assert response.status_code == 200, response.json()
    assert response.json()["status"] == "posted"
    run.refresh_from_db()
    gross, deductions = D("33000") + exp["gross"], D("2000") + exp["deductions"]
    employer, net = D("1800") + exp["employer"], D("31000") + exp["net"]
    assert gl_balance(books, "5200") == gross
    assert gl_balance(books, "5210") == employer
    assert gl_balance(books, "2400") == -net
    assert gl_balance(books, "2410") == -(deductions + employer)
    entry_lines = JournalLine.objects.filter(entry=run.journal_entry)
    assert sum(line.debit for line in entry_lines) == sum(line.credit for line in entry_lines) == gross + employer
    assert {line.cost_center_id for line in entry_lines if line.account.code == "5200"} == {payroll["cost_center"].pk}
    assert run.amount == gross + employer

    # Posted period: attendance and salaries for it are frozen.
    with pytest.raises(ValidationError, match="locked"):
        services.record_attendance(ctx(staff["hr"]), employee=staff["emp"]["worker"], date=day(2), status="absent")


def test_payroll_approval_respects_approval_limit(staff, ctx, books, payroll, org):
    limit = ApprovalLimit.objects.get(document_type="hr.payroll_run")
    limit.max_amount = D("1000")
    limit.save()  # signals refresh the cached authorization store
    officer = ctx(staff["officer"])
    run = services.compute_payroll(
        officer, services.create_payroll_run(officer, company=books, year=TODAY().year, month=TODAY().month)
    )
    run = services.submit_payroll(officer, run)
    with pytest.raises(AuthorizationDenied) as exc:
        services.decide_payroll(ctx(staff["approver"]), run, approve=True)
    assert exc.value.reason == "approval_limit"


def test_statutory_rates_are_data_not_code(staff, ctx, books, payroll, components):
    components["PF_EE"].rate_pct = D("10")
    components["PF_EE"].save()
    officer = ctx(staff["officer"])
    run = services.compute_payroll(
        officer, services.create_payroll_run(officer, company=books, year=TODAY().year, month=TODAY().month)
    )
    slip = Payslip.objects.get(run=run, employee=staff["emp"]["manager"])
    assert slip.lines.get(code="PF_EE").amount == D("1500")  # 10% of the 15000 ceiling


# --- Salary visibility ----------------------------------------------------------------------------------------


@pytest.fixture
def posted_run(staff, ctx, books, payroll):
    officer = ctx(staff["officer"])
    run = services.compute_payroll(
        officer, services.create_payroll_run(officer, company=books, year=TODAY().year, month=TODAY().month)
    )
    run = services.submit_payroll(officer, run)
    run = services.decide_payroll(ctx(staff["approver"]), run, approve=True)
    return services.post_payroll(officer, run)


AMOUNTS = {"gross", "total_deductions", "employer_contributions", "net_pay", "lines"}


def test_amounts_are_hidden_without_salary_read(staff, api_for, posted_run):
    hr_client = api_for(staff["hr"])  # hr.payslip.read and hr.payroll_run.read, no hr.salary.read
    slips = hr_client.get("/api/v1/hr/payslips/").json()["results"]
    assert len(slips) == 2
    assert all(AMOUNTS.isdisjoint(s) for s in slips) and all("paid_days" in s for s in slips)
    run = hr_client.get(f"/api/v1/hr/payroll-runs/{posted_run.pk}/").json()
    assert {"gross_total", "net_total", "amount"}.isdisjoint(run) and run["status"] == "posted"
    assert hr_client.get("/api/v1/hr/salaries/").status_code == 403


def test_salary_read_requires_mfa(staff, api_for, posted_run):
    no_mfa = api_for(staff["officer"], mfa=False)
    denied = no_mfa.get("/api/v1/hr/salaries/")
    assert denied.status_code == 403 and denied.json()["type"] == "mfa_required"
    slips = no_mfa.get("/api/v1/hr/payslips/").json()["results"]
    assert slips and all(AMOUNTS.isdisjoint(s) for s in slips)  # step-up missing: amounts omitted

    with_mfa = api_for(staff["officer"])
    salaries = with_mfa.get("/api/v1/hr/salaries/").json()["results"]
    assert {s["employee_code"] for s in salaries} == {"E001", "E002"}
    assert all(line["amount"] for s in salaries for line in s["lines"])
    slips = with_mfa.get("/api/v1/hr/payslips/").json()["results"]
    assert all(AMOUNTS <= set(s) for s in slips)
    run = with_mfa.get(f"/api/v1/hr/payroll-runs/{posted_run.pk}/").json()
    assert D(run["net_total"]) == posted_run.net_total


def test_employee_reads_only_their_own_payslip(staff, api_for, posted_run, org):
    enable_policy(org, "allow_own_payslip")
    worker = api_for(staff["worker"])
    slips = worker.get("/api/v1/hr/payslips/").json()["results"]
    assert [s["employee_code"] for s in slips] == ["E002"]
    assert AMOUNTS <= set(slips[0])  # own payslip: amounts visible
    other = Payslip.objects.get(run=posted_run, employee=staff["emp"]["manager"])
    assert worker.get(f"/api/v1/hr/payslips/{other.pk}/").status_code == 404
    mine = worker.get("/api/v1/hr/my/payslips/").json()
    assert (
        len(mine) == 1
        and D(mine[0]["net_pay"]) == Payslip.objects.get(run=posted_run, employee=staff["emp"]["worker"]).net_pay
    )
    assert worker.get("/api/v1/hr/salaries/").status_code == 403


def test_self_service_respects_the_module_flag(staff, api_for):
    from apps.core import flags
    from apps.core.models import FeatureFlag

    FeatureFlag.objects.filter(key="module.hr").update(enabled_default=False)
    flags.invalidate()
    response = api_for(staff["worker"]).get("/api/v1/hr/my/profile/")
    assert response.status_code == 404 and response.json()["type"] == "feature_disabled"
