"""HR services: employees, attendance, leave and payroll (public write API of the module).

Conventions
* Every command takes an explicit ActorContext and checks the PDP itself (defence in depth).
* Leave requests and payroll runs go through `apps.shared.workflow`, so approval routes,
  approval limits, self-approval and SoD guards apply.
* Leave days are calendar days, inclusive of both ends; weekends and holidays inside the
  range count as leave days (no holiday calendar is applied).
* Payroll pro-rates by paid days = present + paid leave + holidays (weekly offs are recorded
  as `holiday` attendance). Every other day of the month (absent, unpaid leave, unmarked,
  before joining or after exit) is loss of pay (LOP).
* Statutory rates and ceilings are data on SalaryComponent rows; this module has none in code.
"""

from __future__ import annotations

import calendar
import csv
import io
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.crypto import decrypt_str, encrypt_str
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition
from apps.finance.posting import Line, post_journal, resolve_account
from apps.notifications.models import Category
from apps.notifications.services import notify
from apps.organization.services import allocate_number
from apps.shared import workflow

from .models import (
    AttendanceRecord,
    Employee,
    EmployeeSalary,
    EmployeeSalaryLine,
    LeaveBalance,
    LeaveRequest,
    LeaveType,
    PayrollRun,
    Payslip,
    PayslipLine,
    SalaryComponent,
    SalaryStructure,
    SalaryStructureLine,
)

EMPLOYEE = "hr.employee"
ATTENDANCE = "hr.attendance"
LEAVE_BALANCE = "hr.leave_balance"
LEAVE = "hr.leave_request"
STRUCTURE = "hr.salary_structure"
SALARY = "hr.salary"
RUN = "hr.payroll_run"
PAYSLIP = "hr.payslip"

Q2 = Decimal("0.01")
ZERO = Decimal("0")
# Payroll states that freeze the period's attendance, leave and salary inputs.
LOCKED_RUN_STATUSES = ("submitted", "approved", "posted")
# Default GL determination keys per component kind (the keys map to accounts per company).
DEFAULT_KEYS = {
    SalaryComponent.Kind.EARNING: ("salary_expense", ""),
    SalaryComponent.Kind.DEDUCTION: ("", "statutory_payable"),
    SalaryComponent.Kind.EMPLOYER_CONTRIBUTION: ("employer_contribution", "statutory_payable"),
}
NET_PAY_KEY = "salary_payable"


def money(value) -> Decimal:
    return Decimal(value).quantize(Q2, rounding=ROUND_HALF_UP)


def employee_resource(type_: str, employee: Employee) -> pdp.Resource:
    return pdp.Resource.ref(
        type_, company_id=employee.company_id, department_id=employee.department_id, employee_id=employee.pk
    )


def cost_center_for(company_id, department_id):
    """The active cost centre linked to a department, if the company keeps one (optional)."""
    from apps.finance.models import CostCenter

    return (
        CostCenter.objects.filter(company_id=company_id, department_id=department_id, is_active=True)
        .order_by("code")
        .first()
    )


def _payroll_locked(company_id, day: date) -> bool:
    return PayrollRun.objects.filter(
        company_id=company_id, year=day.year, month=day.month, status__in=LOCKED_RUN_STATUSES
    ).exists()


def _bump(obj, ctx: ActorContext, **changes):
    return workflow.bump(obj, ctx, **changes)


# --- Employees --------------------------------------------------------------------------------------

PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
BANK_RE = re.compile(r"^[0-9]{6,20}$")
AADHAAR4_RE = re.compile(r"^[0-9]{4}$")
SENSITIVE_INPUTS = {
    "pan": ("pan_encrypted", PAN_RE, "Enter a valid PAN (e.g. ABCDE1234F)."),
    "bank_account_number": ("bank_account_encrypted", BANK_RE, "Enter 6 to 20 digits."),
    "aadhaar_last4": ("aadhaar_last4_encrypted", AADHAAR4_RE, "Enter the last 4 digits only."),
}
EMPLOYEE_AUDIT_FIELDS = (
    "code",
    "full_name",
    "department",
    "branch",
    "user",
    "designation",
    "grade",
    "date_of_joining",
    "date_of_exit",
    "status",
    "work_email",
    "phone",
    "bank_ifsc",
)
EMPLOYEE_EDITABLE = (
    "full_name",
    "department",
    "branch",
    "user",
    "designation",
    "grade",
    "date_of_joining",
    "work_email",
    "phone",
    "bank_ifsc",
)


def _apply_sensitive(employee: Employee, data: dict) -> list[str]:
    """Encrypt sensitive inputs present in `data`; an empty value clears the field. Returns changed names."""
    changed, errors = [], {}
    for name, (attr, pattern, message) in SENSITIVE_INPUTS.items():
        if name not in data:
            continue
        raw = (data[name] or "").strip().upper().replace(" ", "")
        if raw and not pattern.match(raw):
            errors[name] = [message]
            continue
        setattr(employee, attr, encrypt_str(raw) if raw else "")
        changed.append(name)
    if errors:
        raise ValidationError(errors)
    return changed


def _decrypt(token: str) -> str:
    return decrypt_str(token) if token else ""


def sensitive_hints(employee: Employee) -> dict:
    """Masked hints only: the full values are never served by the API."""
    pan, account, aadhaar = (
        _decrypt(employee.pan_encrypted),
        _decrypt(employee.bank_account_encrypted),
        _decrypt(employee.aadhaar_last4_encrypted),
    )
    return {
        "pan_masked": f"XXXXX{pan[5:9][:2]}XX{pan[-1:]}" if pan else "",
        "bank_account_masked": f"XXXX{account[-4:]}" if account else "",
        "aadhaar_masked": f"XXXX-XXXX-XX{aadhaar[-2:]}" if aadhaar else "",
    }


def _check_org_links(company, department, branch) -> None:
    if department.company_id != company.pk:
        raise ValidationError({"department": ["Department belongs to another company."]})
    if branch is not None and branch.company_id != company.pk:
        raise ValidationError({"branch": ["Branch belongs to another company."]})


def _link_user(ctx: ActorContext, employee: Employee, user, previous_user_id=None) -> None:
    """Keep `identity.User.employee_id` in step with the employee link (feeds `subject.employee_id`)."""
    from apps.identity.models import User

    if user is not None:
        if user.organization_id != getattr(ctx.user, "organization_id", user.organization_id):
            raise ValidationError({"user": ["User belongs to another organization."]})
        if user.employee_id and user.employee_id != employee.pk:
            raise ValidationError({"user": ["This user is already linked to another employee."]})
        User.objects.filter(pk=user.pk).update(employee_id=employee.pk)
    if previous_user_id and (user is None or previous_user_id != user.pk):
        User.objects.filter(pk=previous_user_id, employee_id=employee.pk).update(employee_id=None)
    audit.record(
        "hr.employee.user_linked",
        ctx=ctx,
        resource_type=EMPLOYEE,
        resource_id=employee.pk,
        company_id=employee.company_id,
        changes={"user": str(user.pk) if user else None, "previous_user": str(previous_user_id or "") or None},
    )


@transaction.atomic
def create_employee(
    ctx: ActorContext,
    *,
    company,
    department,
    code: str,
    full_name: str,
    date_of_joining: date,
    user=None,
    branch=None,
    designation: str = "",
    grade: str = "",
    work_email: str = "",
    phone: str = "",
    bank_ifsc: str = "",
    **sensitive,
) -> Employee:
    pdp.require(
        ctx, f"{EMPLOYEE}.create", pdp.Resource.ref(EMPLOYEE, company_id=company.pk, department_id=department.pk)
    )
    _check_org_links(company, department, branch)
    unknown = set(sensitive) - set(SENSITIVE_INPUTS)
    if unknown:
        raise ValidationError({name: ["Unknown field."] for name in sorted(unknown)})
    if Employee.objects.filter(company=company, code=code).exists():
        raise ValidationError({"code": ["An employee with this code already exists."]})
    employee = Employee(
        company=company,
        department=department,
        branch=branch,
        code=code,
        full_name=full_name,
        date_of_joining=date_of_joining,
        designation=designation,
        grade=grade,
        work_email=work_email,
        phone=phone,
        bank_ifsc=bank_ifsc.upper(),
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    changed = _apply_sensitive(employee, sensitive)
    employee.save()
    if user is not None:
        employee.user = user
        employee.save(update_fields=["user"])
        _link_user(ctx, employee, user)
    audit.record(
        "hr.employee.created",
        ctx=ctx,
        resource_type=EMPLOYEE,
        resource_id=employee.pk,
        company_id=company.pk,
        summary=f"{code} {full_name}",
        changes={"after": audit.snapshot(employee, EMPLOYEE_AUDIT_FIELDS), "sensitive_set": sorted(changed)},
    )
    return employee


@transaction.atomic
def update_employee(ctx: ActorContext, employee: Employee, data: dict, expected_version: int | None) -> Employee:
    employee = Employee.objects.select_for_update().get(pk=employee.pk)
    pdp.require(ctx, f"{EMPLOYEE}.update", pdp.Resource.of(employee))
    workflow.check(employee, expected_version)
    if expected_version is None:
        raise ValidationError({"version": ["Send the version you edited (optimistic locking)."]})
    unknown = set(data) - set(EMPLOYEE_EDITABLE) - set(SENSITIVE_INPUTS)
    if unknown:
        raise ValidationError({name: ["This field cannot be changed."] for name in sorted(unknown)})
    if employee.status == Employee.Status.EXITED:
        raise InvalidStateTransition("Exited employees can't be changed.")
    before = audit.snapshot(employee, EMPLOYEE_AUDIT_FIELDS)
    previous_user_id = employee.user_id
    department = data.get("department", employee.department)
    if department.pk != employee.department_id:
        # Moving an employee needs authority over the destination department too.
        pdp.require(
            ctx,
            f"{EMPLOYEE}.update",
            pdp.Resource.ref(EMPLOYEE, company_id=employee.company_id, department_id=department.pk),
        )
    _check_org_links(employee.company, department, data.get("branch", employee.branch))
    for key in EMPLOYEE_EDITABLE:
        if key in data:
            setattr(employee, key, data[key])
    changed = _apply_sensitive(employee, data)
    _bump(employee, ctx)
    new_user = data.get("user", employee.user)
    if "user" in data and (new_user.pk if new_user else None) != previous_user_id:
        _link_user(ctx, employee, data["user"], previous_user_id)
    changes = audit.diff(before, audit.snapshot(employee, EMPLOYEE_AUDIT_FIELDS))
    changes.update({name: {"from": audit.MASK, "to": audit.MASK} for name in changed})
    if changes:
        audit.record(
            "hr.employee.updated",
            ctx=ctx,
            resource_type=EMPLOYEE,
            resource_id=employee.pk,
            company_id=employee.company_id,
            changes=changes,
        )
    return employee


@transaction.atomic
def exit_employee(ctx: ActorContext, employee: Employee, *, date_of_exit: date, expected_version=None) -> Employee:
    employee = Employee.objects.select_for_update().get(pk=employee.pk)
    pdp.require(ctx, f"{EMPLOYEE}.update", pdp.Resource.of(employee))
    workflow.check(employee, expected_version)
    if employee.status != Employee.Status.ACTIVE:
        raise InvalidStateTransition("The employee has already exited.")
    if date_of_exit < employee.date_of_joining:
        raise ValidationError({"date_of_exit": ["Exit can't be before the joining date."]})
    _bump(employee, ctx, status=Employee.Status.EXITED, date_of_exit=date_of_exit)
    audit.record(
        "hr.employee.exited",
        ctx=ctx,
        resource_type=EMPLOYEE,
        resource_id=employee.pk,
        company_id=employee.company_id,
        changes={"date_of_exit": str(date_of_exit)},
    )
    return employee


def check_filer(ctx: ActorContext, employee: Employee) -> None:
    """Filing a request for someone else needs authority over that employee's HR record."""
    if ctx.is_system or (ctx.user is not None and employee.user_id == ctx.user.pk):
        return
    pdp.require(ctx, f"{EMPLOYEE}.read", pdp.Resource.of(employee))


def employee_for_user(user, company_id=None) -> Employee | None:
    if user is None or not user.pk:
        return None
    qs = Employee.objects.select_related("department").filter(user=user)
    if company_id is not None:
        qs = qs.filter(company_id=company_id)
    return qs.order_by("-status", "created_at").first()


# --- Attendance ---------------------------------------------------------------------------------------

TIMED_STATUSES = {AttendanceRecord.Status.PRESENT, AttendanceRecord.Status.HALF_DAY}


def _attendance_errors(employee: Employee, day: date, status: str, check_in, check_out) -> list[tuple[str, str]]:
    errors = []
    if status not in AttendanceRecord.Status.values or status == AttendanceRecord.Status.LEAVE:
        errors.append(("status", "Use present, absent, half_day or holiday (leave comes from leave requests)."))
    if day < employee.date_of_joining or (employee.date_of_exit and day > employee.date_of_exit):
        errors.append(("date", "The employee isn't employed on this date."))
    if (check_in or check_out) and status not in TIMED_STATUSES:
        errors.append(("check_in", "Check-in/out times apply only to present or half-day records."))
    if check_in and check_out and check_out < check_in:
        errors.append(("check_out", "Check-out is before check-in."))
    if _payroll_locked(employee.company_id, day):
        errors.append(("date", "Payroll for this month is already submitted; attendance is locked."))
    return errors


@transaction.atomic
def record_attendance(
    ctx: ActorContext,
    *,
    employee: Employee,
    date: date,
    status: str,
    check_in: time | None = None,
    check_out: time | None = None,
    remarks: str = "",
) -> AttendanceRecord:
    """Create or correct one day's manual attendance."""
    existing = AttendanceRecord.objects.select_for_update().filter(employee=employee, date=date).first()
    action = "update" if existing else "create"
    pdp.require(ctx, f"{ATTENDANCE}.{action}", employee_resource(ATTENDANCE, employee))
    errors = _attendance_errors(employee, date, status, check_in, check_out)
    if existing is not None and existing.source == AttendanceRecord.Source.LEAVE:
        errors.append(("date", "This day is covered by an approved leave request."))
    if errors:
        raise ValidationError({f: [m] for f, m in errors})
    fields = ("status", "check_in", "check_out", "remarks", "source")
    before = audit.snapshot(existing, fields) if existing else {}
    record = existing or AttendanceRecord(
        employee=employee, company_id=employee.company_id, date=date, created_by=ctx.user
    )
    record.status, record.check_in, record.check_out, record.remarks = status, check_in, check_out, remarks
    record.source, record.updated_by = AttendanceRecord.Source.MANUAL, ctx.user
    record.save()
    audit.record(
        f"{ATTENDANCE}.{'updated' if existing else 'created'}",
        ctx=ctx,
        resource_type=ATTENDANCE,
        resource_id=record.pk,
        company_id=employee.company_id,
        summary=f"{employee.code} {date}",
        changes=audit.diff(before, audit.snapshot(record, fields)),
    )
    return record


IMPORT_COLUMNS = ("employee_code", "date", "status")


def _parse_time(raw: str):
    raw = (raw or "").strip()
    return time.fromisoformat(raw) if raw else None


@transaction.atomic
def import_attendance(ctx: ActorContext, *, company, csv_text: str, overwrite: bool = False) -> dict:
    """All-or-nothing CSV import. Columns: employee_code,date,status[,check_in,check_out,remarks].

    Every row is validated first; if any row fails, nothing is written and the per-row errors are
    returned in the error's `meta.errors` (row numbers count the header as row 1).
    """
    if not pdp.has_any_grant(ctx, f"{ATTENDANCE}.create"):
        raise AuthorizationDenied()
    reader = csv.DictReader(io.StringIO(csv_text.strip()))
    headers = {h.strip() for h in (reader.fieldnames or [])}
    missing = [c for c in IMPORT_COLUMNS if c not in headers]
    if missing:
        raise ValidationError({"csv": [f"Missing column(s): {', '.join(missing)}."]})
    rows = [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in reader]
    if not rows:
        raise ValidationError({"csv": ["The file has no data rows."]})
    employees = {e.code: e for e in Employee.objects.filter(company=company)}
    existing = {}
    errors, parsed, seen = [], [], set()
    for number, row in enumerate(rows, start=2):
        row_errors = []
        employee = employees.get(row.get("employee_code", ""))
        if employee is None or not pdp.can(ctx, f"{ATTENDANCE}.create", employee_resource(ATTENDANCE, employee)):
            row_errors.append(("employee_code", "Unknown employee code."))
        try:
            day = date.fromisoformat(row.get("date", ""))
        except ValueError:
            day = None
            row_errors.append(("date", "Use YYYY-MM-DD."))
        try:
            check_in, check_out = _parse_time(row.get("check_in", "")), _parse_time(row.get("check_out", ""))
        except ValueError:
            check_in = check_out = None
            row_errors.append(("check_in", "Use HH:MM."))
        status = row.get("status", "").lower()
        if employee is not None and day is not None and not row_errors:
            row_errors.extend(_attendance_errors(employee, day, status, check_in, check_out))
            key = (employee.pk, day)
            if key in seen:
                row_errors.append(("date", "Duplicate employee and date in the file."))
            seen.add(key)
            current = AttendanceRecord.objects.filter(employee=employee, date=day).first()
            if current is not None:
                if current.source == AttendanceRecord.Source.LEAVE:
                    row_errors.append(("date", "This day is covered by an approved leave request."))
                elif not overwrite:
                    row_errors.append(("date", "Attendance is already recorded for this day."))
                existing[key] = current
        if row_errors:
            errors.extend({"row": number, "field": f, "message": m} for f, m in row_errors)
        else:
            parsed.append((employee, day, status, check_in, check_out, row.get("remarks", "")[:300]))
    if errors:
        raise BusinessRuleViolation(
            f"{len({e['row'] for e in errors})} row(s) have errors; nothing was imported.",
            code="attendance_import_invalid",
            meta={"errors": errors},
        )
    created = updated = 0
    for employee, day, status, check_in, check_out, remarks in parsed:
        record = existing.get((employee.pk, day))
        if record is None:
            record = AttendanceRecord(employee=employee, company_id=company.pk, date=day, created_by=ctx.user)
            created += 1
        else:
            updated += 1
        record.status, record.check_in, record.check_out, record.remarks = status, check_in, check_out, remarks
        record.source, record.updated_by = AttendanceRecord.Source.IMPORT, ctx.user
        record.save()
    audit.record(
        f"{ATTENDANCE}.imported",
        ctx=ctx,
        resource_type=ATTENDANCE,
        company_id=company.pk,
        summary=f"{created} created, {updated} updated",
        changes={"rows": len(parsed), "created": created, "updated": updated, "overwrite": overwrite},
    )
    return {"rows": len(parsed), "created": created, "updated": updated}


# --- Leave ----------------------------------------------------------------------------------------------


def leave_days(from_date: date, to_date: date) -> Decimal:
    """Calendar days, both ends inclusive."""
    return Decimal((to_date - from_date).days + 1)


@transaction.atomic
def allocate_leave(
    ctx: ActorContext, *, employee: Employee, leave_type: LeaveType, year: int, allocated: Decimal | None = None
) -> LeaveBalance:
    if leave_type.company_id != employee.company_id:
        raise ValidationError({"leave_type": ["Leave type belongs to another company."]})
    if not leave_type.is_paid:
        raise ValidationError({"leave_type": ["Unpaid leave has no balance to allocate."]})
    allocated = leave_type.annual_quota if allocated is None else Decimal(allocated)
    balance = (
        LeaveBalance.objects.select_for_update().filter(employee=employee, leave_type=leave_type, year=year).first()
    )
    pdp.require(ctx, f"{LEAVE_BALANCE}.{'update' if balance else 'create'}", employee_resource(LEAVE_BALANCE, employee))
    if balance is None:
        balance = LeaveBalance.objects.create(
            company_id=employee.company_id,
            employee=employee,
            leave_type=leave_type,
            year=year,
            allocated=allocated,
            created_by=ctx.user,
            updated_by=ctx.user,
        )
        before = None
    else:
        if allocated < balance.used:
            raise ValidationError({"allocated": [f"{balance.used} day(s) are already used."]})
        before = str(balance.allocated)
        _bump(balance, ctx, allocated=allocated)
    audit.record(
        f"{LEAVE_BALANCE}.allocated",
        ctx=ctx,
        resource_type=LEAVE_BALANCE,
        resource_id=balance.pk,
        company_id=employee.company_id,
        summary=f"{employee.code} {leave_type.code} {year}",
        changes={"allocated": {"from": before, "to": str(allocated)}},
    )
    return balance


def _check_leave(leave: LeaveRequest, *, lock: bool = False) -> LeaveBalance | None:
    if leave.from_date.year != leave.to_date.year:
        raise ValidationError({"to_date": ["Split leave that crosses a calendar year into two requests."]})
    overlap = (
        LeaveRequest.objects.filter(
            employee_id=leave.employee_id,
            status__in=["submitted", "approved"],
            from_date__lte=leave.to_date,
            to_date__gte=leave.from_date,
        )
        .exclude(pk=leave.pk)
        .exists()
    )
    if overlap:
        raise BusinessRuleViolation("Another leave request covers some of these days.", code="leave_overlap")
    if not leave.leave_type.is_paid:
        return None
    qs = LeaveBalance.objects.filter(
        employee_id=leave.employee_id, leave_type=leave.leave_type, year=leave.from_date.year
    )
    balance = (qs.select_for_update() if lock else qs).first()
    available = balance.available if balance else ZERO
    if leave.days > available:
        raise BusinessRuleViolation(
            f"Only {available} day(s) of {leave.leave_type.name} are available.",
            code="insufficient_leave_balance",
            meta={"available": str(available), "requested": str(leave.days)},
        )
    return balance


@transaction.atomic
def create_leave_request(
    ctx: ActorContext, *, employee: Employee, leave_type: LeaveType, from_date: date, to_date: date, reason: str = ""
) -> LeaveRequest:
    pdp.require(ctx, f"{LEAVE}.create", employee_resource(LEAVE, employee))
    check_filer(ctx, employee)
    if employee.status != Employee.Status.ACTIVE:
        raise BusinessRuleViolation("The employee is not active.", code="employee_inactive")
    if leave_type.company_id != employee.company_id or not leave_type.is_active:
        raise ValidationError({"leave_type": ["Choose an active leave type of the employee's company."]})
    if to_date < from_date:
        raise ValidationError({"to_date": ["Must be on or after the start date."]})
    leave = LeaveRequest(
        company_id=employee.company_id,
        employee=employee,
        leave_type=leave_type,
        from_date=from_date,
        to_date=to_date,
        days=leave_days(from_date, to_date),
        reason=reason,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    _check_leave(leave)
    leave.save()
    audit.record(
        f"{LEAVE}.created",
        ctx=ctx,
        resource_type=LEAVE,
        resource_id=leave.pk,
        company_id=leave.company_id,
        summary=f"{employee.code} {leave_type.code} {from_date}..{to_date}",
    )
    return leave


@transaction.atomic
def submit_leave_request(ctx: ActorContext, leave: LeaveRequest, expected_version=None) -> LeaveRequest:
    leave = LeaveRequest.objects.select_related("employee", "leave_type").get(pk=leave.pk)
    _check_leave(leave)
    return workflow.submit(
        ctx,
        leave,
        document_type=LEAVE,
        title=f"Leave: {leave.employee.full_name}, {leave.from_date} to {leave.to_date} ({leave.days} days)",
        summary={"days": str(leave.days), "leave_type": leave.leave_type.code, "employee": leave.employee.code},
        scope={"department_id": leave.employee.department_id, "branch_id": leave.employee.branch_id},
        expected_version=expected_version,
    )


def _deny_own_leave(ctx: ActorContext, leave: LeaveRequest) -> None:
    """The employee can never decide their own leave, even when someone else filed it for them."""
    if ctx.user is not None and leave.employee.user_id == ctx.user.pk:
        raise AuthorizationDenied(reason="self_approval")


def _apply_approved_leave(leave: LeaveRequest, ctx: ActorContext) -> None:
    """Deduct the balance and mark attendance. Also the approval-route completion callback."""
    leave = LeaveRequest.objects.select_related("employee", "leave_type").get(pk=leave.pk)
    _deny_own_leave(ctx, leave)
    balance = _check_leave(leave, lock=True)
    if balance is not None:
        _bump(balance, ctx, used=balance.used + leave.days)
    day = leave.from_date
    while day <= leave.to_date:
        if _payroll_locked(leave.company_id, day):
            raise BusinessRuleViolation("Payroll for this period is already submitted.", code="payroll_locked")
        record = AttendanceRecord.objects.select_for_update().filter(employee_id=leave.employee_id, date=day).first()
        if record is not None and record.status in TIMED_STATUSES:
            raise BusinessRuleViolation(
                f"The employee is marked {record.status} on {day}.", code="attendance_conflict", meta={"date": str(day)}
            )
        if record is None:
            record = AttendanceRecord(
                company_id=leave.company_id, employee_id=leave.employee_id, date=day, created_by=ctx.user
            )
        record.status, record.leave_type, record.source = AttendanceRecord.Status.LEAVE, leave.leave_type, "leave"
        record.check_in = record.check_out = None
        record.remarks, record.updated_by = f"Leave request {leave.pk}"[:300], ctx.user
        record.save()
        day += timedelta(days=1)
    audit.record(
        f"{LEAVE}.applied",
        ctx=ctx,
        resource_type=LEAVE,
        resource_id=leave.pk,
        company_id=leave.company_id,
        changes={"days": str(leave.days), "balance_after": str(balance.available) if balance else None},
    )


@transaction.atomic
def decide_leave_request(
    ctx: ActorContext, leave: LeaveRequest, *, approve: bool, comment: str = "", expected_version=None
) -> LeaveRequest:
    leave = LeaveRequest.objects.select_related("employee").get(pk=leave.pk)
    _deny_own_leave(ctx, leave)
    leave = workflow.decide_directly(
        ctx, leave, document_type=LEAVE, approve=approve, comment=comment, expected_version=expected_version
    )
    if approve:
        _apply_approved_leave(leave, ctx)
    _notify_employee(
        leave.employee,
        f"Leave {'approved' if approve else 'rejected'}: {leave.from_date} to {leave.to_date}",
        f"/hr/leave-requests/{leave.pk}",
        LEAVE,
        leave.pk,
    )
    return leave


@transaction.atomic
def cancel_leave_request(ctx: ActorContext, leave: LeaveRequest, *, reason: str = "", expected_version=None):
    """Draft/rejected requests are cancelled; approved ones only before they start (balance restored)."""
    leave = LeaveRequest.objects.select_for_update().select_related("employee", "leave_type").get(pk=leave.pk)
    workflow.check(leave, expected_version, "draft", "rejected", "approved")
    pdp.require(ctx, f"{LEAVE}.cancel", pdp.Resource.of(leave))
    if leave.status == "approved":
        if leave.from_date <= timezone.localdate():
            raise BusinessRuleViolation("Leave that has started can't be cancelled.", code="leave_started")
        balance = (
            LeaveBalance.objects.select_for_update()
            .filter(employee_id=leave.employee_id, leave_type=leave.leave_type, year=leave.from_date.year)
            .first()
        )
        if balance is not None and leave.leave_type.is_paid:
            _bump(balance, ctx, used=balance.used - leave.days)
        AttendanceRecord.objects.filter(
            employee_id=leave.employee_id,
            date__range=(leave.from_date, leave.to_date),
            source=AttendanceRecord.Source.LEAVE,
        ).delete()
    previous = leave.status
    _bump(leave, ctx, status="cancelled")
    audit.record(
        f"{LEAVE}.cancelled",
        ctx=ctx,
        resource_type=LEAVE,
        resource_id=leave.pk,
        company_id=leave.company_id,
        summary=reason[:500],
        changes={"status": {"from": previous, "to": "cancelled"}},
    )
    return leave


def _notify_employee(employee: Employee, title: str, link: str, resource_type: str, resource_id) -> None:
    if employee.user_id:
        notify(
            [employee.user],
            category=Category.APPROVAL,
            title=title,
            link=link,
            resource_type=resource_type,
            resource_id=resource_id,
            company_id=employee.company_id,
        )


workflow.register(LEAVE, LeaveRequest, "Leave request", "/hr/leave-requests", on_approved=_apply_approved_leave)


# --- Salary configuration ---------------------------------------------------------------------------------


def validate_component(company_id, attrs: dict) -> None:
    """Shape rules for a component (also enforced by DB constraints) and resolvable GL keys."""
    errors = {}
    kind, calc = attrs.get("kind"), attrs.get("calculation", SalaryComponent.Calculation.FIXED)
    if calc != SalaryComponent.Calculation.FIXED and attrs.get("rate_pct") is None:
        errors["rate_pct"] = ["A percentage component needs a rate."]
    if kind == SalaryComponent.Kind.EARNING and calc == SalaryComponent.Calculation.PERCENT_OF_GROSS:
        errors["calculation"] = ["Earnings can't be a percentage of gross."]
    if attrs.get("is_basic") and (kind != SalaryComponent.Kind.EARNING or calc != SalaryComponent.Calculation.FIXED):
        errors["is_basic"] = ["Basic must be a fixed earning."]
    for key_field in ("expense_key", "liability_key"):
        key = attrs.get(key_field)
        if key:
            try:
                resolve_account(company_id, key)
            except BusinessRuleViolation:
                errors[key_field] = [f"No account is configured for '{key}'."]
    if errors:
        raise ValidationError(errors)


@transaction.atomic
def create_structure(ctx: ActorContext, *, company, code: str, name: str, lines: list[dict]) -> SalaryStructure:
    pdp.require(ctx, f"{STRUCTURE}.create", pdp.Resource.ref(STRUCTURE, company_id=company.pk))
    if SalaryStructure.objects.filter(company=company, code=code).exists():
        raise ValidationError({"code": ["A structure with this code already exists."]})
    components = [line["component"] for line in lines]
    if any(c.company_id != company.pk or not c.is_active for c in components):
        raise ValidationError({"lines": ["Use active components of this company."]})
    if len({c.pk for c in components}) != len(components):
        raise ValidationError({"lines": ["A component appears twice."]})
    if sum(1 for c in components if c.is_basic) != 1:
        raise ValidationError({"lines": ["A structure needs exactly one basic component."]})
    structure = SalaryStructure.objects.create(
        company=company, code=code, name=name, created_by=ctx.user, updated_by=ctx.user
    )
    for line in lines:
        SalaryStructureLine.objects.create(
            structure=structure, component=line["component"], amount=line.get("amount"), rate_pct=line.get("rate_pct")
        )
    audit.record(
        f"{STRUCTURE}.created",
        ctx=ctx,
        resource_type=STRUCTURE,
        resource_id=structure.pk,
        company_id=company.pk,
        summary=f"{code} {name}",
        changes={"components": [c.code for c in components]},
    )
    return structure


def _posted_through(company_id) -> date | None:
    return PayrollRun.objects.filter(company_id=company_id, status__in=LOCKED_RUN_STATUSES).aggregate(
        last=Max("period_end")
    )["last"]


def _salary_lines(employee: Employee, structure: SalaryStructure, lines: list[dict]) -> list[tuple]:
    if structure.company_id != employee.company_id or not structure.is_active:
        raise ValidationError({"structure": ["Choose an active structure of the employee's company."]})
    fixed = {
        sl.component_id: sl
        for sl in structure.lines.select_related("component")
        if sl.component.calculation == SalaryComponent.Calculation.FIXED
    }
    result, seen = [], set()
    for line in lines:
        component = line["component"]
        if component.pk not in fixed:
            raise ValidationError({"lines": [f"{component.code} isn't a fixed component of {structure.code}."]})
        if component.pk in seen:
            raise ValidationError({"lines": [f"{component.code} appears twice."]})
        if Decimal(line["amount"]) < 0:
            raise ValidationError({"lines": ["Amounts can't be negative."]})
        seen.add(component.pk)
        result.append((component, money(line["amount"])))
    basic = next((sl for sl in fixed.values() if sl.component.is_basic), None)
    if basic is not None and basic.component_id not in seen and not basic.amount:
        raise ValidationError({"lines": [f"Enter the {basic.component.name} amount."]})
    return result


@transaction.atomic
def assign_salary(
    ctx: ActorContext,
    *,
    employee: Employee,
    structure: SalaryStructure,
    effective_from: date,
    lines: list[dict],
    notes: str = "",
) -> EmployeeSalary:
    pdp.require(ctx, f"{SALARY}.create", employee_resource(SALARY, employee))
    if effective_from < employee.date_of_joining:
        raise ValidationError({"effective_from": ["Can't be before the joining date."]})
    locked_until = _posted_through(employee.company_id)
    if locked_until and effective_from <= locked_until:
        raise ValidationError({"effective_from": [f"Payroll is already submitted up to {locked_until}."]})
    if EmployeeSalary.objects.filter(employee=employee, effective_from=effective_from).exists():
        raise ValidationError({"effective_from": ["A salary already starts on this date."]})
    amounts = _salary_lines(employee, structure, lines)
    salary = EmployeeSalary.objects.create(
        company_id=employee.company_id,
        employee=employee,
        structure=structure,
        effective_from=effective_from,
        notes=notes,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    EmployeeSalaryLine.objects.bulk_create(
        [EmployeeSalaryLine(salary=salary, component=c, amount=a) for c, a in amounts]
    )
    audit.record(
        f"{SALARY}.assigned",
        ctx=ctx,
        resource_type=SALARY,
        resource_id=salary.pk,
        company_id=employee.company_id,
        summary=f"{employee.code} from {effective_from}",
        changes={"structure": structure.code, "effective_from": str(effective_from), "amounts": audit.MASK},
    )
    return salary


@transaction.atomic
def update_salary(
    ctx: ActorContext, salary: EmployeeSalary, *, lines: list[dict], notes: str | None = None, expected_version=None
) -> EmployeeSalary:
    salary = EmployeeSalary.objects.select_for_update().select_related("employee", "structure").get(pk=salary.pk)
    pdp.require(ctx, f"{SALARY}.update", pdp.Resource.of(salary))
    workflow.check(salary, expected_version)
    if Payslip.objects.filter(salary=salary, run__status__in=LOCKED_RUN_STATUSES).exists():
        raise BusinessRuleViolation(
            "This salary was used in a submitted payroll. Assign a new salary with a later effective date.",
            code="salary_in_use",
        )
    amounts = _salary_lines(salary.employee, salary.structure, lines)
    before = {line.component.code: str(line.amount) for line in salary.lines.select_related("component")}
    salary.lines.all().delete()
    EmployeeSalaryLine.objects.bulk_create(
        [EmployeeSalaryLine(salary=salary, component=c, amount=a) for c, a in amounts]
    )
    _bump(salary, ctx, **({"notes": notes} if notes is not None else {}))
    after = {c.code: str(a) for c, a in amounts}
    audit.record(
        f"{SALARY}.updated",
        ctx=ctx,
        resource_type=SALARY,
        resource_id=salary.pk,
        company_id=salary.company_id,
        changes=audit.diff(before, after, sensitive=set(before) | set(after)),
    )
    return salary


def salary_for(employee: Employee, on: date) -> EmployeeSalary | None:
    return (
        EmployeeSalary.objects.filter(employee=employee, effective_from__lte=on)
        .select_related("structure")
        .order_by("-effective_from")
        .first()
    )


# --- Payroll ------------------------------------------------------------------------------------------------


@transaction.atomic
def create_payroll_run(ctx: ActorContext, *, company, year: int, month: int) -> PayrollRun:
    pdp.require(ctx, f"{RUN}.create", pdp.Resource.ref(RUN, company_id=company.pk))
    if not 1 <= month <= 12:
        raise ValidationError({"month": ["Use 1 to 12."]})
    if PayrollRun.objects.filter(company=company, year=year, month=month).exists():
        raise ValidationError({"month": ["A payroll run already exists for this month."]})
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    run = PayrollRun.objects.create(
        company=company,
        year=year,
        month=month,
        period_start=start,
        period_end=end,
        currency=company.base_currency,
        number=allocate_number(company.pk, "PAY", end),
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        f"{RUN}.created", ctx=ctx, resource_type=RUN, resource_id=run.pk, company_id=company.pk, summary=run.number
    )
    return run


@dataclass
class _Computed:
    employee: Employee
    salary: EmployeeSalary
    days_in_period: Decimal
    present: Decimal = ZERO
    paid_leave: Decimal = ZERO
    holidays: Decimal = ZERO
    lines: list[dict] = field(default_factory=list)

    @property
    def paid_days(self) -> Decimal:
        return self.present + self.paid_leave + self.holidays

    def total(self, kind: str) -> Decimal:
        return sum((line["amount"] for line in self.lines if line["kind"] == kind), ZERO)


def _attendance_days(run: PayrollRun, employee: Employee) -> tuple[Decimal, Decimal, Decimal]:
    start = max(run.period_start, employee.date_of_joining)
    end = min(run.period_end, employee.date_of_exit or run.period_end)
    present = paid_leave = holidays = ZERO
    if end < start:
        return present, paid_leave, holidays
    for record in AttendanceRecord.objects.filter(employee=employee, date__range=(start, end)).select_related(
        "leave_type"
    ):
        if record.status == AttendanceRecord.Status.PRESENT:
            present += 1
        elif record.status == AttendanceRecord.Status.HALF_DAY:
            present += Decimal("0.5")
        elif record.status == AttendanceRecord.Status.HOLIDAY:
            holidays += 1
        elif record.status == AttendanceRecord.Status.LEAVE and record.leave_type and record.leave_type.is_paid:
            paid_leave += 1
    return present, paid_leave, holidays


def compute_payslip(run: PayrollRun, employee: Employee, salary: EmployeeSalary) -> _Computed:
    days = Decimal(calendar.monthrange(run.year, run.month)[1])
    result = _Computed(employee=employee, salary=salary, days_in_period=days)
    result.present, result.paid_leave, result.holidays = _attendance_days(run, employee)
    ratio = result.paid_days / days
    overrides = {line.component_id: line.amount for line in salary.lines.all()}
    structure_lines = sorted(
        (sl for sl in salary.structure.lines.select_related("component") if sl.component.is_active),
        key=lambda sl: (sl.component.sequence, sl.component.code),
    )

    def fixed_amount(sl) -> Decimal:
        return Decimal(overrides.get(sl.component_id, sl.amount or ZERO))

    def rate(sl) -> Decimal:
        return Decimal(sl.rate_pct if sl.rate_pct is not None else sl.component.rate_pct)

    def add(sl, base, amount, rate_pct=None):
        comp = sl.component
        expense_default, liability_default = DEFAULT_KEYS[comp.kind]
        result.lines.append(
            {
                "component": comp,
                "code": comp.code,
                "name": comp.name,
                "kind": comp.kind,
                "is_statutory": comp.is_statutory,
                "base_amount": money(base),
                "rate_pct": rate_pct,
                "amount": money(amount),
                "expense_key": comp.expense_key or expense_default,
                "liability_key": comp.liability_key or liability_default,
            }
        )

    earnings = [sl for sl in structure_lines if sl.component.kind == SalaryComponent.Kind.EARNING]
    basic_full = sum((fixed_amount(sl) for sl in earnings if sl.component.is_basic), ZERO)
    basic_earned = ZERO
    for sl in earnings:
        comp = sl.component
        if comp.calculation == SalaryComponent.Calculation.FIXED:
            full, rate_pct = fixed_amount(sl), None
        else:
            rate_pct = rate(sl)
            full = basic_full * rate_pct / 100
        earned = money(full * ratio) if comp.prorate else money(full)
        if comp.is_basic:
            basic_earned += earned
        add(sl, full, earned, rate_pct)
    gross = result.total(SalaryComponent.Kind.EARNING)
    if gross <= 0:
        return result  # nothing earned: nothing to deduct from

    for sl in structure_lines:
        comp = sl.component
        if comp.kind == SalaryComponent.Kind.EARNING:
            continue
        if comp.gross_max is not None and gross > comp.gross_max:
            continue
        if comp.gross_min is not None and gross < comp.gross_min:
            continue
        if comp.calculation == SalaryComponent.Calculation.FIXED:
            base, rate_pct = fixed_amount(sl), None
            amount = base * ratio if comp.prorate else base
        else:
            rate_pct = rate(sl)
            base = basic_earned if comp.calculation == SalaryComponent.Calculation.PERCENT_OF_BASIC else gross
            if comp.wage_ceiling is not None:
                base = min(base, comp.wage_ceiling)
            amount = base * rate_pct / 100
        if money(amount) > 0:
            add(sl, base, amount, rate_pct)
    if result.total(SalaryComponent.Kind.DEDUCTION) > gross:
        raise BusinessRuleViolation(
            f"Deductions exceed gross pay for {employee.code}.",
            code="negative_net_pay",
            meta={"employee": employee.code},
        )
    return result


@transaction.atomic
def compute_payroll(ctx: ActorContext, run: PayrollRun, expected_version=None) -> PayrollRun:
    run = PayrollRun.objects.select_for_update().get(pk=run.pk)
    workflow.check(run, expected_version, "draft", "computed", "rejected")
    pdp.require(ctx, f"{RUN}.update", pdp.Resource.of(run))
    run.payslips.all().delete()
    employees = (
        Employee.objects.filter(company_id=run.company_id, date_of_joining__lte=run.period_end)
        .exclude(date_of_exit__lt=run.period_start)
        .select_related("department")
        .order_by("code")
    )
    totals = defaultdict(lambda: ZERO)
    count, skipped = 0, []
    for employee in employees:
        salary = salary_for(employee, run.period_end)
        if salary is None:
            skipped.append(employee.code)
            continue
        computed = compute_payslip(run, employee, salary)
        gross = computed.total(SalaryComponent.Kind.EARNING)
        deductions = computed.total(SalaryComponent.Kind.DEDUCTION)
        employer = computed.total(SalaryComponent.Kind.EMPLOYER_CONTRIBUTION)
        cost_center = cost_center_for(run.company_id, employee.department_id)
        payslip = Payslip.objects.create(
            company_id=run.company_id,
            run=run,
            employee=employee,
            department_id=employee.department_id,
            salary=salary,
            cost_center=cost_center,
            days_in_period=computed.days_in_period,
            present_days=computed.present,
            paid_leave_days=computed.paid_leave,
            holiday_days=computed.holidays,
            paid_days=computed.paid_days,
            lop_days=computed.days_in_period - computed.paid_days,
            gross=gross,
            total_deductions=deductions,
            employer_contributions=employer,
            net_pay=gross - deductions,
            created_by=ctx.user,
            updated_by=ctx.user,
        )
        PayslipLine.objects.bulk_create([PayslipLine(payslip=payslip, **line) for line in computed.lines])
        totals["gross"] += gross
        totals["deductions"] += deductions
        totals["employer"] += employer
        count += 1
    _bump(
        run,
        ctx,
        status="computed",
        employee_count=count,
        gross_total=totals["gross"],
        deduction_total=totals["deductions"],
        employer_total=totals["employer"],
        net_total=totals["gross"] - totals["deductions"],
        amount=totals["gross"] + totals["employer"],
        computed_at=timezone.now(),
        submitted_by=None,
        approved_by=None,
    )
    audit.record(
        f"{RUN}.computed",
        ctx=ctx,
        resource_type=RUN,
        resource_id=run.pk,
        company_id=run.company_id,
        summary=f"{run.number}: {count} payslips",
        changes={"employees": count, "skipped_without_salary": skipped},
    )
    return run


def submit_payroll(ctx: ActorContext, run: PayrollRun, expected_version=None) -> PayrollRun:
    if not run.payslips.exists():
        raise BusinessRuleViolation("The payroll has no payslips. Compute it first.", code="payroll_empty")
    return workflow.submit(
        ctx,
        run,
        document_type=RUN,
        title=f"Payroll {run.number} ({run.year}-{run.month:02d})",
        summary={"employees": run.employee_count, "period": f"{run.year}-{run.month:02d}"},
        expected_version=expected_version,
        from_statuses=("computed",),
    )


@transaction.atomic
def reverse_payroll(
    ctx: ActorContext, run: PayrollRun, *, reason: str, reversal_date: date | None = None, expected_version=None
) -> PayrollRun:
    """Undo a posted run with a reversing journal (the original stays on record). The month reopens for a
    corrected run. Reverse only before salaries are paid out, or settle the payments separately."""
    from apps.finance.posting import reverse_journal

    run = PayrollRun.objects.select_for_update().get(pk=run.pk)
    workflow.check(run, expected_version, "posted")
    pdp.require(ctx, f"{RUN}.reverse", pdp.Resource.of(run))
    if not reason.strip():
        raise ValidationError({"reason": ["Give the reason for reversing this payroll."]})
    reversal = None
    if run.journal_entry_id:
        reversal = reverse_journal(
            ctx,
            run.journal_entry,
            reversal_date=reversal_date or timezone.localdate(),
            reason=f"Payroll {run.number} reversed: {reason.strip()}"[:300],
        )
    _bump(run, ctx, status="reversed")
    audit.record(
        f"{RUN}.reversed",
        ctx=ctx,
        resource_type=RUN,
        resource_id=run.pk,
        company_id=run.company_id,
        summary=f"{run.number}: {reason.strip()}"[:500],
        changes={"reversal_entry": str(reversal.pk) if reversal else None},
    )
    return run


def decide_payroll(ctx: ActorContext, run: PayrollRun, *, approve: bool, comment: str = "", expected_version=None):
    return workflow.decide_directly(
        ctx, run, document_type=RUN, approve=approve, comment=comment, expected_version=expected_version
    )


@transaction.atomic
def post_payroll(ctx: ActorContext, run: PayrollRun, *, posting_date: date | None = None, expected_version=None):
    """One balanced journal: Dr salary expense (+ employer contributions), Cr net pay and statutory dues."""
    run = PayrollRun.objects.select_for_update().get(pk=run.pk)
    workflow.check(run, expected_version, "approved")
    pdp.require(ctx, f"{RUN}.post", pdp.Resource.of(run))
    posting_date = posting_date or run.period_end
    amounts: dict[tuple, Decimal] = defaultdict(lambda: ZERO)
    payslips = list(run.payslips.prefetch_related("lines").select_related("employee"))
    for payslip in payslips:
        cc = payslip.cost_center_id
        for line in payslip.lines.all():
            if line.kind == SalaryComponent.Kind.EARNING:
                amounts[(line.expense_key, cc)] += line.amount
            elif line.kind == SalaryComponent.Kind.DEDUCTION:
                amounts[(line.liability_key, None)] -= line.amount
            else:
                amounts[(line.expense_key, cc)] += line.amount
                amounts[(line.liability_key, None)] -= line.amount
        amounts[(NET_PAY_KEY, None)] -= payslip.net_pay
    lines = [Line(amount=amount, key=key, cost_center_id=cc) for (key, cc), amount in amounts.items()]
    entry = post_journal(
        ctx,
        company_id=run.company_id,
        entry_date=posting_date,
        lines=lines,
        narration=f"Payroll {run.number} for {run.year}-{run.month:02d}",
        source_module="hr",
        source_type=RUN,
        source_id=run.pk,
    )
    _bump(
        run,
        ctx,
        status="posted",
        posted_by=ctx.user,
        posted_at=timezone.now(),
        posting_date=posting_date,
        journal_entry=entry,
    )
    audit.record(
        f"{RUN}.posted",
        ctx=ctx,
        resource_type=RUN,
        resource_id=run.pk,
        company_id=run.company_id,
        summary=run.number,
        changes={"journal_entry": str(entry.pk) if entry else None, "payslips": len(payslips)},
    )
    for payslip in payslips:
        _notify_employee(
            payslip.employee,
            f"Your payslip for {run.year}-{run.month:02d} is available",
            "/hr/my/payslips",
            PAYSLIP,
            payslip.pk,
        )
    return run


workflow.register(RUN, PayrollRun, "Payroll run", "/hr/payroll-runs")


# --- Salary visibility ----------------------------------------------------------------------------------------


def can_read_salary(ctx: ActorContext, *, company_id, department_id=None, employee_id=None) -> bool:
    """`hr.salary.read` (MFA-protected) over the employee, or the caller's own record."""
    user = ctx.user
    if employee_id is not None and user is not None and getattr(user, "employee_id", None) == employee_id:
        return True
    attrs = {"company_id": company_id}
    if department_id is not None:
        attrs["department_id"] = department_id
    if employee_id is not None:
        attrs["employee_id"] = employee_id
    return pdp.can(ctx, f"{SALARY}.read", pdp.Resource.ref(SALARY, **attrs))


def own_payslips_q(user) -> Q:
    """An employee sees their own payslips only once the run is posted."""
    employee_id = getattr(user, "employee_id", None)
    if employee_id is None:
        return Q()
    return ~Q(employee_id=employee_id) | Q(run__status="posted")
