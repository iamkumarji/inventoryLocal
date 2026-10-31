"""Expenses services: claims, advances, fuel logs (public write API of the module).

* Claims go through `apps.shared.workflow` (approval routes, approval limits, self-approval).
  Approval posts Dr category expense keys / Cr reimbursements payable (Cr employee advance for any
  advance settled). Paying posts Dr reimbursements payable / Cr bank (maker-checker: payer is not
  the claimant, the preparer or the submitter).
* Limits and receipt thresholds come from ExpenseCategory rows.
* Filing for another employee needs `hr.employee.read` over that employee in addition to the
  create permission; anyone may file for themselves with the create permission.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from django.db import connection, transaction
from django.db.models import Max, Min
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation
from apps.finance.posting import Line, post_journal, resolve_account
from apps.hr import services as hr
from apps.hr.models import Employee
from apps.notifications.models import Category
from apps.notifications.services import notify
from apps.organization.services import allocate_number
from apps.shared import workflow

from .models import EmployeeAdvance, ExpenseClaim, ExpenseClaimLine, FuelLog

CATEGORY = "expenses.expense_category"
CLAIM = "expenses.expense_claim"
ADVANCE = "expenses.employee_advance"
FUEL = "expenses.fuel_log"

Q2 = Decimal("0.01")
ZERO = Decimal("0")
PAYABLE_KEY = "employee_reimbursement_payable"
ADVANCE_KEY = "employee_advance"
BANK_KEY = "default_bank"


def money(value) -> Decimal:
    return Decimal(value).quantize(Q2, rounding=ROUND_HALF_UP)


def normalize_vehicle(registration: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (registration or "").upper())


def validate_gl_key(company_id, key: str) -> None:
    try:
        resolve_account(company_id, key)
    except BusinessRuleViolation:
        raise ValidationError({"gl_key": [f"No account is configured for '{key}'."]})


def _resource(type_: str, employee: Employee, branch=None) -> pdp.Resource:
    return pdp.Resource.ref(
        type_,
        company_id=employee.company_id,
        branch_id=branch.pk if branch else None,
        department_id=employee.department_id,
        employee_id=employee.pk,
    )


def _deny_own(ctx: ActorContext, employee: Employee) -> None:
    """Nobody decides their own claim or advance, even when someone else filed it for them."""
    if ctx.user is not None and employee.user_id == ctx.user.pk:
        raise AuthorizationDenied(reason="self_approval")


def _deny_maker(ctx: ActorContext, doc, employee: Employee) -> None:
    makers = {doc.created_by_id, doc.submitted_by_id, employee.user_id} - {None}
    if ctx.user is not None and ctx.user.pk in makers:
        raise AuthorizationDenied(reason="maker_checker")


def _notify(employee: Employee, title: str, link: str, resource_type: str, resource_id) -> None:
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


# --- Fuel logs --------------------------------------------------------------------------------------


def _lock_vehicle(company_id, vehicle: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [f"fuel:{company_id}:{vehicle}"])


def odometer_error(company_id, vehicle: str, log_date: date, odometer: Decimal, exclude_line=None) -> str | None:
    logs = FuelLog.objects.filter(company_id=company_id, vehicle_registration=vehicle)
    if exclude_line is not None:
        logs = logs.exclude(claim_line=exclude_line)
    prior = logs.filter(log_date__lte=log_date).aggregate(v=Max("odometer"))["v"]
    later = logs.filter(log_date__gt=log_date).aggregate(v=Min("odometer"))["v"]
    if prior is not None and odometer <= prior:
        return f"Odometer must be above the previous reading ({prior.normalize():f}) for {vehicle}."
    if later is not None and odometer >= later:
        return f"Odometer must be below the later reading ({later.normalize():f}) recorded for {vehicle}."
    return None


def _record_fuel(
    ctx: ActorContext,
    *,
    driver: Employee,
    vehicle_registration: str,
    log_date: date,
    odometer: Decimal,
    litres: Decimal,
    rate: Decimal,
    remarks: str = "",
    claim_line=None,
) -> FuelLog:
    vehicle = normalize_vehicle(vehicle_registration)
    if not vehicle:
        raise ValidationError({"vehicle_registration": ["Enter the vehicle registration."]})
    if Decimal(litres) <= 0:
        raise ValidationError({"litres": ["Must be greater than zero."]})
    if Decimal(rate) < 0 or Decimal(odometer) < 0:
        raise ValidationError({"rate": ["Rate and odometer can't be negative."]})
    _lock_vehicle(driver.company_id, vehicle)
    error = odometer_error(driver.company_id, vehicle, log_date, Decimal(odometer))
    if error:
        raise BusinessRuleViolation(error, code="odometer_not_monotonic")
    log = FuelLog.objects.create(
        company_id=driver.company_id,
        vehicle_registration=vehicle,
        log_date=log_date,
        odometer=odometer,
        litres=litres,
        rate=rate,
        amount=money(Decimal(litres) * Decimal(rate)),
        driver=driver,
        department_id=driver.department_id,
        claim_line=claim_line,
        remarks=remarks,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        f"{FUEL}.recorded",
        ctx=ctx,
        resource_type=FUEL,
        resource_id=log.pk,
        company_id=log.company_id,
        summary=f"{vehicle} @ {odometer}",
        changes={
            "litres": str(litres),
            "amount": str(log.amount),
            "claim_line": str(claim_line.pk) if claim_line else None,
        },
    )
    return log


@transaction.atomic
def record_fuel(
    ctx: ActorContext,
    *,
    driver: Employee,
    vehicle_registration: str,
    log_date: date,
    odometer: Decimal,
    litres: Decimal,
    rate: Decimal,
    remarks: str = "",
) -> FuelLog:
    pdp.require(
        ctx, f"{FUEL}.create", pdp.Resource.ref(FUEL, company_id=driver.company_id, department_id=driver.department_id)
    )
    return _record_fuel(
        ctx,
        driver=driver,
        vehicle_registration=vehicle_registration,
        log_date=log_date,
        odometer=odometer,
        litres=litres,
        rate=rate,
        remarks=remarks,
    )


# --- Claims ---------------------------------------------------------------------------------------------


def _validate_header(employee: Employee, branch, cost_center, advance) -> None:
    if branch is not None and branch.company_id != employee.company_id:
        raise ValidationError({"branch": ["Branch belongs to another company."]})
    if cost_center is not None and (cost_center.company_id != employee.company_id or not cost_center.is_active):
        raise ValidationError({"cost_center": ["Choose an active cost centre of the employee's company."]})
    if advance is not None:
        if advance.employee_id != employee.pk:
            raise ValidationError({"advance": ["The advance belongs to another employee."]})
        if advance.status != "paid" or advance.outstanding <= 0:
            raise ValidationError({"advance": ["Only a paid advance with an outstanding balance can be settled."]})


def _replace_lines(claim: ExpenseClaim, lines: list[dict]) -> None:
    if not lines:
        raise ValidationError({"lines": ["Add at least one expense line."]})
    claim.lines.all().delete()
    total = ZERO
    for number, line in enumerate(lines, start=1):
        category = line["category"]
        if category.company_id != claim.company_id or not category.is_active:
            raise ValidationError({"lines": [f"Line {number}: choose an active category of this company."]})
        amount = money(line["amount"])
        if amount <= 0:
            raise ValidationError({"lines": [f"Line {number}: amount must be greater than zero."]})
        ExpenseClaimLine.objects.create(
            claim=claim,
            line_no=number,
            category=category,
            expense_date=line["expense_date"],
            description=line["description"],
            amount=amount,
            receipt_reference=line.get("receipt_reference", "") or "",
            vehicle_registration=normalize_vehicle(line.get("vehicle_registration", "")),
            odometer=line.get("odometer"),
            litres=line.get("litres"),
        )
        total += amount
    claim.amount = total
    claim.net_payable = total
    claim.save(update_fields=["amount", "net_payable"])


CLAIM_AUDIT_FIELDS = ("claim_date", "purpose", "branch", "cost_center", "advance", "amount")


@transaction.atomic
def create_claim(
    ctx: ActorContext,
    *,
    employee: Employee,
    claim_date: date,
    purpose: str,
    lines: list[dict],
    branch=None,
    cost_center=None,
    advance=None,
) -> ExpenseClaim:
    branch = branch or employee.branch
    pdp.require(ctx, f"{CLAIM}.create", _resource(CLAIM, employee, branch))
    hr.check_filer(ctx, employee)
    if employee.status != Employee.Status.ACTIVE:
        raise BusinessRuleViolation("The employee is not active.", code="employee_inactive")
    _validate_header(employee, branch, cost_center, advance)
    claim = ExpenseClaim.objects.create(
        company_id=employee.company_id,
        employee=employee,
        department_id=employee.department_id,
        branch=branch,
        cost_center=cost_center,
        claim_date=claim_date,
        purpose=purpose,
        advance=advance,
        currency=employee.company.base_currency,
        number=allocate_number(employee.company_id, "EXP", claim_date),
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    _replace_lines(claim, lines)
    audit.record(
        f"{CLAIM}.created",
        ctx=ctx,
        resource_type=CLAIM,
        resource_id=claim.pk,
        company_id=claim.company_id,
        summary=f"{claim.number} {employee.code} {claim.amount}",
        changes={"after": audit.snapshot(claim, CLAIM_AUDIT_FIELDS)},
    )
    return claim


@transaction.atomic
def update_claim(ctx: ActorContext, claim: ExpenseClaim, data: dict, expected_version: int | None) -> ExpenseClaim:
    claim = ExpenseClaim.objects.select_for_update().select_related("employee").get(pk=claim.pk)
    if expected_version is None:
        raise ValidationError({"version": ["Send the version you edited (optimistic locking)."]})
    workflow.check(claim, expected_version, "draft", "rejected")
    pdp.require(ctx, f"{CLAIM}.update", pdp.Resource.of(claim))
    before = audit.snapshot(claim, CLAIM_AUDIT_FIELDS)
    for key in ("claim_date", "purpose", "branch", "cost_center", "advance"):
        if key in data:
            setattr(claim, key, data[key])
    _validate_header(claim.employee, claim.branch, claim.cost_center, claim.advance)
    if "lines" in data:
        _replace_lines(claim, data["lines"])
    workflow.bump(claim, ctx)
    changes = audit.diff(before, audit.snapshot(claim, CLAIM_AUDIT_FIELDS))
    audit.record(
        f"{CLAIM}.updated",
        ctx=ctx,
        resource_type=CLAIM,
        resource_id=claim.pk,
        company_id=claim.company_id,
        changes={**changes, "lines_replaced": "lines" in data},
    )
    return claim


def claim_errors(claim: ExpenseClaim) -> list[dict]:
    """Category limits, receipts and fuel details (all data-driven)."""
    errors = []
    lines = list(claim.lines.select_related("category").order_by("line_no"))
    if not lines:
        return [{"line": None, "field": "lines", "message": "Add at least one expense line."}]
    today = timezone.localdate()
    per_category = defaultdict(lambda: ZERO)
    vehicles: dict[str, list[ExpenseClaimLine]] = defaultdict(list)
    for line in lines:
        category = line.category
        per_category[category] += line.amount
        if line.expense_date > today:
            errors.append({"line": line.line_no, "field": "expense_date", "message": "Expense date is in the future."})
        threshold = category.receipt_required_above
        if threshold is not None and line.amount > threshold and not line.receipt_reference.strip():
            errors.append(
                {
                    "line": line.line_no,
                    "field": "receipt_reference",
                    "message": f"{category.name} above {threshold.normalize():f} needs a receipt.",
                }
            )
        if category.requires_vehicle:
            missing = [f for f in ("vehicle_registration", "odometer", "litres") if getattr(line, f) in (None, "")]
            for f in missing:
                errors.append({"line": line.line_no, "field": f, "message": f"{category.name} needs {f}."})
            if not missing:
                if line.litres <= 0:
                    errors.append({"line": line.line_no, "field": "litres", "message": "Litres must be positive."})
                vehicles[line.vehicle_registration].append(line)
    for category, total in per_category.items():
        if category.per_claim_limit is not None and total > category.per_claim_limit:
            errors.append(
                {
                    "line": None,
                    "field": "amount",
                    "message": f"{category.name} totals {total.normalize():f}, above the per-claim limit of "
                    f"{category.per_claim_limit.normalize():f}.",
                }
            )
    for vehicle, vehicle_lines in vehicles.items():
        previous = None
        for line in sorted(vehicle_lines, key=lambda x: (x.expense_date, x.odometer)):
            if previous is not None and line.odometer <= previous.odometer:
                errors.append(
                    {
                        "line": line.line_no,
                        "field": "odometer",
                        "message": f"Odometer readings for {vehicle} must rise.",
                    }
                )
            error = odometer_error(claim.company_id, vehicle, line.expense_date, line.odometer, exclude_line=line)
            if error:
                errors.append({"line": line.line_no, "field": "odometer", "message": error})
            previous = line
    return errors


@transaction.atomic
def submit_claim(ctx: ActorContext, claim: ExpenseClaim, expected_version=None) -> ExpenseClaim:
    claim = ExpenseClaim.objects.select_related("employee", "advance").get(pk=claim.pk)
    errors = claim_errors(claim)
    if claim.advance_id:
        try:
            _validate_header(claim.employee, claim.branch, claim.cost_center, claim.advance)
        except ValidationError as exc:
            errors.append({"line": None, "field": "advance", "message": str(exc.detail["advance"][0])})
    if errors:
        raise BusinessRuleViolation(
            "The claim doesn't meet the expense policy.", code="expense_policy_violation", meta={"errors": errors}
        )
    return workflow.submit(
        ctx,
        claim,
        document_type=CLAIM,
        title=f"Expense claim {claim.number}: {claim.employee.full_name}, {claim.purpose}",
        summary={"employee": claim.employee.code, "lines": claim.lines.count()},
        scope={"branch_id": claim.branch_id, "department_id": claim.department_id},
        expected_version=expected_version,
    )


def _post_claim_approval(claim: ExpenseClaim, ctx: ActorContext) -> None:
    """Approval journal (also the approval-route completion callback)."""
    claim = ExpenseClaim.objects.select_for_update().select_related("employee").get(pk=claim.pk)
    _deny_own(ctx, claim.employee)
    settled = ZERO
    if claim.advance_id:
        advance = EmployeeAdvance.objects.select_for_update().get(pk=claim.advance_id)
        if advance.status != "paid":
            raise BusinessRuleViolation("The linked advance is no longer open.", code="advance_not_open")
        settled = min(advance.outstanding, claim.amount)
        new_settled = advance.settled_amount + settled
        workflow.bump(
            advance,
            ctx,
            settled_amount=new_settled,
            status="settled" if new_settled == advance.amount else advance.status,
        )
        audit.record(
            f"{ADVANCE}.settled",
            ctx=ctx,
            resource_type=ADVANCE,
            resource_id=advance.pk,
            company_id=advance.company_id,
            summary=f"{settled} against {claim.number}",
            changes={"claim": str(claim.pk), "settled": str(settled), "status": advance.status},
        )
    cost_center = claim.cost_center or hr.cost_center_for(claim.company_id, claim.department_id)
    cc_id = cost_center.pk if cost_center else None
    lines = [
        Line(amount=line.amount, key=line.category.gl_key, cost_center_id=cc_id, description=line.category.name)
        for line in claim.lines.select_related("category")
    ]
    lines.append(Line(amount=-settled, key=ADVANCE_KEY))
    lines.append(Line(amount=-(claim.amount - settled), key=PAYABLE_KEY))
    entry = post_journal(
        ctx,
        company_id=claim.company_id,
        entry_date=timezone.localdate(),
        lines=lines,
        narration=f"Expense claim {claim.number}: {claim.employee.full_name}",
        source_module="expenses",
        source_type=CLAIM,
        source_id=claim.pk,
    )
    for line in claim.lines.select_related("category").filter(category__requires_vehicle=True):
        _record_fuel(
            ctx,
            driver=claim.employee,
            vehicle_registration=line.vehicle_registration,
            log_date=line.expense_date,
            odometer=line.odometer,
            litres=line.litres,
            rate=(line.amount / line.litres).quantize(Decimal("0.000001")),
            remarks=f"Claim {claim.number} line {line.line_no}",
            claim_line=line,
        )
    claim.advance_settled = settled
    claim.net_payable = claim.amount - settled
    claim.approval_journal = entry
    claim.save(update_fields=["advance_settled", "net_payable", "approval_journal", "updated_at"])
    audit.record(
        f"{CLAIM}.posted",
        ctx=ctx,
        resource_type=CLAIM,
        resource_id=claim.pk,
        company_id=claim.company_id,
        summary=claim.number,
        changes={"journal_entry": str(entry.pk) if entry else None, "advance_settled": str(settled)},
    )


@transaction.atomic
def decide_claim(
    ctx: ActorContext, claim: ExpenseClaim, *, approve: bool, comment: str = "", expected_version=None
) -> ExpenseClaim:
    claim = ExpenseClaim.objects.select_related("employee").get(pk=claim.pk)
    _deny_own(ctx, claim.employee)
    claim = workflow.decide_directly(
        ctx, claim, document_type=CLAIM, approve=approve, comment=comment, expected_version=expected_version
    )
    if approve:
        _post_claim_approval(claim, ctx)
    _notify(
        claim.employee,
        f"Expense claim {claim.number} {'approved' if approve else 'rejected'}",
        f"/expenses/claims/{claim.pk}",
        CLAIM,
        claim.pk,
    )
    return claim


@transaction.atomic
def mark_paid(
    ctx: ActorContext, claim: ExpenseClaim, *, paid_on: date, bank_reference: str, expected_version=None
) -> ExpenseClaim:
    claim = ExpenseClaim.objects.select_for_update().select_related("employee").get(pk=claim.pk)
    workflow.check(claim, expected_version, "approved")
    pdp.require(ctx, f"{CLAIM}.pay", pdp.Resource.of(claim))
    _deny_maker(ctx, claim, claim.employee)
    if not bank_reference.strip():
        raise ValidationError({"bank_reference": ["Enter the bank reference."]})
    entry = post_journal(
        ctx,
        company_id=claim.company_id,
        entry_date=paid_on,
        lines=[Line(amount=claim.net_payable, key=PAYABLE_KEY), Line(amount=-claim.net_payable, key=BANK_KEY)],
        narration=f"Reimbursement of {claim.number} ({bank_reference})",
        source_module="expenses",
        source_type=CLAIM,
        source_id=claim.pk,
    )
    workflow.bump(
        claim,
        ctx,
        status="paid",
        paid_by=ctx.user,
        paid_on=paid_on,
        bank_reference=bank_reference.strip(),
        payment_journal=entry,
    )
    audit.record(
        f"{CLAIM}.paid",
        ctx=ctx,
        resource_type=CLAIM,
        resource_id=claim.pk,
        company_id=claim.company_id,
        summary=f"{claim.number} {claim.net_payable}",
        changes={
            "paid_on": str(paid_on),
            "bank_reference": bank_reference,
            "journal_entry": str(entry.pk) if entry else None,
        },
    )
    _notify(claim.employee, f"Expense claim {claim.number} paid", f"/expenses/claims/{claim.pk}", CLAIM, claim.pk)
    return claim


workflow.register(CLAIM, ExpenseClaim, "Expense claim", "/expenses/claims", on_approved=_post_claim_approval)


# --- Advances --------------------------------------------------------------------------------------------


@transaction.atomic
def request_advance(
    ctx: ActorContext, *, employee: Employee, amount: Decimal, purpose: str, branch=None
) -> EmployeeAdvance:
    branch = branch or employee.branch
    pdp.require(ctx, f"{ADVANCE}.create", _resource(ADVANCE, employee, branch))
    hr.check_filer(ctx, employee)
    if employee.status != Employee.Status.ACTIVE:
        raise BusinessRuleViolation("The employee is not active.", code="employee_inactive")
    if money(amount) <= 0:
        raise ValidationError({"amount": ["Must be greater than zero."]})
    advance = EmployeeAdvance.objects.create(
        company_id=employee.company_id,
        employee=employee,
        department_id=employee.department_id,
        branch=branch,
        amount=money(amount),
        currency=employee.company.base_currency,
        purpose=purpose,
        submitted_by=ctx.user,
        number=allocate_number(employee.company_id, "ADV", timezone.localdate()),
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        f"{ADVANCE}.requested",
        ctx=ctx,
        resource_type=ADVANCE,
        resource_id=advance.pk,
        company_id=advance.company_id,
        summary=f"{advance.number} {employee.code} {advance.amount}",
    )
    return advance


@transaction.atomic
def decide_advance(
    ctx: ActorContext, advance: EmployeeAdvance, *, approve: bool, comment: str = "", expected_version=None
) -> EmployeeAdvance:
    advance = EmployeeAdvance.objects.select_for_update().select_related("employee").get(pk=advance.pk)
    workflow.check(advance, expected_version, "requested")
    _deny_own(ctx, advance.employee)
    pdp.require(ctx, f"{ADVANCE}.{'approve' if approve else 'reject'}", pdp.Resource.of(advance))
    workflow.bump(advance, ctx, status="approved" if approve else "rejected", approved_by=ctx.user if approve else None)
    audit.record(
        f"{ADVANCE}.{'approved' if approve else 'rejected'}",
        ctx=ctx,
        resource_type=ADVANCE,
        resource_id=advance.pk,
        company_id=advance.company_id,
        summary=comment[:500],
    )
    _notify(
        advance.employee,
        f"Advance {advance.number} {'approved' if approve else 'rejected'}",
        f"/expenses/advances/{advance.pk}",
        ADVANCE,
        advance.pk,
    )
    return advance


@transaction.atomic
def pay_advance(
    ctx: ActorContext, advance: EmployeeAdvance, *, paid_on: date, bank_reference: str, expected_version=None
) -> EmployeeAdvance:
    advance = EmployeeAdvance.objects.select_for_update().select_related("employee").get(pk=advance.pk)
    workflow.check(advance, expected_version, "approved")
    pdp.require(ctx, f"{ADVANCE}.pay", pdp.Resource.of(advance))
    _deny_maker(ctx, advance, advance.employee)
    if not bank_reference.strip():
        raise ValidationError({"bank_reference": ["Enter the bank reference."]})
    entry = post_journal(
        ctx,
        company_id=advance.company_id,
        entry_date=paid_on,
        lines=[Line(amount=advance.amount, key=ADVANCE_KEY), Line(amount=-advance.amount, key=BANK_KEY)],
        narration=f"Employee advance {advance.number} ({bank_reference})",
        source_module="expenses",
        source_type=ADVANCE,
        source_id=advance.pk,
    )
    workflow.bump(
        advance,
        ctx,
        status="paid",
        paid_by=ctx.user,
        paid_on=paid_on,
        bank_reference=bank_reference.strip(),
        payment_journal=entry,
    )
    audit.record(
        f"{ADVANCE}.paid",
        ctx=ctx,
        resource_type=ADVANCE,
        resource_id=advance.pk,
        company_id=advance.company_id,
        summary=f"{advance.number} {advance.amount}",
        changes={"paid_on": str(paid_on), "journal_entry": str(entry.pk) if entry else None},
    )
    return advance
