"""HR: employees, attendance, leave and payroll (SRS module 11).

Scope attributes: employee-owned records expose the employee's company and department so that
department-scoped grants (a manager approving leave in their department) match them.
Statutory rates and ceilings live on `SalaryComponent` rows (data), never in code.
"""

from django.conf import settings
from django.db import models
from django.db.models import F, Q

from apps.core.fields import MoneyField, PercentField
from apps.core.models import CompanyScopedModel, UUIDModel, VersionedModel

DAYS = {"max_digits": 6, "decimal_places": 2}


class Employee(CompanyScopedModel, VersionedModel):
    class Status(models.TextChoices):
        ACTIVE = "active"
        EXITED = "exited"

    code = models.CharField(max_length=30)
    full_name = models.CharField(max_length=200)
    department = models.ForeignKey("organization.Department", on_delete=models.PROTECT, related_name="+")
    branch = models.ForeignKey("organization.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    designation = models.CharField(max_length=120, blank=True)
    grade = models.CharField(max_length=40, blank=True)
    date_of_joining = models.DateField()
    date_of_exit = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.ACTIVE)
    work_email = models.EmailField(blank=True)
    phone = models.CharField(max_length=30, blank=True)
    # Sensitive personal data: Fernet-encrypted at rest (apps.core.crypto); only masked hints are served.
    pan_encrypted = models.TextField(blank=True)
    bank_account_encrypted = models.TextField(blank=True)
    bank_ifsc = models.CharField(max_length=11, blank=True)
    aadhaar_last4_encrypted = models.TextField(blank=True)  # never the full Aadhaar number

    authz_resource_type = "hr.employee"
    authz_scope_fields = {"company": "company_id", "department": "department_id"}

    class Meta:
        db_table = "hr_employees"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_hr_employee_code"),
            models.UniqueConstraint(
                fields=["company", "user"], condition=Q(user__isnull=False), name="uq_hr_employee_user"
            ),
            models.CheckConstraint(condition=Q(status__in=["active", "exited"]), name="ck_hr_employee_status"),
            models.CheckConstraint(
                condition=Q(date_of_exit__isnull=True) | Q(date_of_exit__gte=F("date_of_joining")),
                name="ck_hr_employee_exit_after_joining",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} - {self.full_name}"


class EmployeeScopedModel(CompanyScopedModel):
    """Records owned by an employee: authorization scope follows the employee's current department."""

    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="+")

    authz_scope_fields = {"company": "company_id", "department": "employee__department_id"}

    class Meta:
        abstract = True

    def authz_attributes(self) -> dict:
        attrs = super().authz_attributes()
        attrs["employee__department_id"] = self.employee.department_id
        attrs["department_id"] = self.employee.department_id
        return attrs


# --- Attendance ---------------------------------------------------------------------------------


class AttendanceRecord(EmployeeScopedModel):
    class Status(models.TextChoices):
        PRESENT = "present"
        ABSENT = "absent"
        HALF_DAY = "half_day"
        LEAVE = "leave"
        HOLIDAY = "holiday"  # public holidays and weekly offs

    class Source(models.TextChoices):
        MANUAL = "manual"
        IMPORT = "import"
        LEAVE = "leave"  # written when a leave request is approved

    date = models.DateField()
    status = models.CharField(max_length=10, choices=Status.choices)
    check_in = models.TimeField(null=True, blank=True)
    check_out = models.TimeField(null=True, blank=True)
    source = models.CharField(max_length=10, choices=Source.choices, default=Source.MANUAL)
    leave_type = models.ForeignKey("LeaveType", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    remarks = models.CharField(max_length=300, blank=True)

    authz_resource_type = "hr.attendance"

    class Meta:
        db_table = "hr_attendance"
        constraints = [
            models.UniqueConstraint(fields=["employee", "date"], name="uq_hr_attendance_employee_date"),
            models.CheckConstraint(
                condition=Q(status__in=["present", "absent", "half_day", "leave", "holiday"]),
                name="ck_hr_attendance_status",
            ),
            models.CheckConstraint(
                condition=Q(check_in__isnull=True) | Q(check_out__isnull=True) | Q(check_out__gte=F("check_in")),
                name="ck_hr_attendance_times",
            ),
        ]
        indexes = [models.Index(fields=["company", "date"], name="ix_hr_attendance_date")]


# --- Leave ----------------------------------------------------------------------------------------


class LeaveType(CompanyScopedModel, VersionedModel):
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=100)
    is_paid = models.BooleanField(default=True)
    annual_quota = models.DecimalField(default=0, **DAYS)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "hr.leave_type"

    class Meta:
        db_table = "hr_leave_types"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_hr_leave_type_code"),
            models.CheckConstraint(condition=Q(annual_quota__gte=0), name="ck_hr_leave_type_quota"),
        ]


class LeaveBalance(EmployeeScopedModel, VersionedModel):
    leave_type = models.ForeignKey(LeaveType, on_delete=models.PROTECT, related_name="+")
    year = models.PositiveSmallIntegerField()
    allocated = models.DecimalField(default=0, **DAYS)
    used = models.DecimalField(default=0, **DAYS)

    authz_resource_type = "hr.leave_balance"

    class Meta:
        db_table = "hr_leave_balances"
        constraints = [
            models.UniqueConstraint(fields=["employee", "leave_type", "year"], name="uq_hr_leave_balance"),
            models.CheckConstraint(
                condition=Q(used__gte=0, allocated__gte=0, used__lte=F("allocated")), name="ck_hr_leave_balance"
            ),
        ]

    @property
    def available(self):
        return self.allocated - self.used


class LeaveRequest(EmployeeScopedModel, VersionedModel):
    """Days are calendar days, inclusive of both ends (weekends and holidays inside the range count)."""

    leave_type = models.ForeignKey(LeaveType, on_delete=models.PROTECT, related_name="+")
    from_date = models.DateField()
    to_date = models.DateField()
    days = models.DecimalField(**DAYS)
    reason = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=20, default="draft")  # draft|submitted|approved|rejected|cancelled
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "hr.leave_request"

    class Meta:
        db_table = "hr_leave_requests"
        constraints = [
            models.CheckConstraint(condition=Q(to_date__gte=F("from_date")), name="ck_hr_leave_dates"),
            models.CheckConstraint(condition=Q(days__gt=0), name="ck_hr_leave_days"),
        ]


# --- Payroll configuration --------------------------------------------------------------------------


class SalaryComponent(CompanyScopedModel, VersionedModel):
    """A pay element. Statutory deductions (PF, ESI, PT...) are rows here with their rates and ceilings.

    * `calculation`: fixed amount, or `rate_pct` of the earned basic / earned gross.
    * `wage_ceiling`: the percentage base is capped at this amount (e.g. a PF wage ceiling).
    * `gross_max` / `gross_min`: the component applies only if the earned gross is <= / >= the value
      (e.g. ESI eligibility, professional-tax slabs).
    * `expense_key` / `liability_key`: GL determination keys; blank means the default for the kind.
    """

    class Kind(models.TextChoices):
        EARNING = "earning"
        DEDUCTION = "deduction"
        EMPLOYER_CONTRIBUTION = "employer_contribution"

    class Calculation(models.TextChoices):
        FIXED = "fixed"
        PERCENT_OF_BASIC = "percent_of_basic"
        PERCENT_OF_GROSS = "percent_of_gross"

    code = models.CharField(max_length=20)
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=25, choices=Kind.choices)
    calculation = models.CharField(max_length=20, choices=Calculation.choices, default=Calculation.FIXED)
    is_basic = models.BooleanField(default=False)
    is_statutory = models.BooleanField(default=False)
    prorate = models.BooleanField(default=True)  # fixed amounts scale with paid days
    rate_pct = PercentField(null=True, blank=True)
    wage_ceiling = MoneyField(null=True, blank=True)
    gross_max = MoneyField(null=True, blank=True)
    gross_min = MoneyField(null=True, blank=True)
    expense_key = models.CharField(max_length=40, blank=True)
    liability_key = models.CharField(max_length=40, blank=True)
    sequence = models.PositiveSmallIntegerField(default=100)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "hr.salary_structure"

    class Meta:
        db_table = "hr_salary_components"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_hr_salary_component_code"),
            models.CheckConstraint(
                condition=Q(kind__in=["earning", "deduction", "employer_contribution"]), name="ck_hr_component_kind"
            ),
            models.CheckConstraint(
                condition=Q(calculation="fixed") | Q(rate_pct__isnull=False), name="ck_hr_component_rate_required"
            ),
            models.CheckConstraint(
                condition=Q(is_basic=False) | Q(kind="earning", calculation="fixed"), name="ck_hr_component_basic"
            ),
        ]


class SalaryStructure(CompanyScopedModel, VersionedModel):
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=100)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "hr.salary_structure"

    class Meta:
        db_table = "hr_salary_structures"
        constraints = [models.UniqueConstraint(fields=["company", "code"], name="uq_hr_salary_structure_code")]


class SalaryStructureLine(UUIDModel):
    """`amount` is the default for fixed components; `rate_pct` overrides the component's rate."""

    structure = models.ForeignKey(SalaryStructure, on_delete=models.CASCADE, related_name="lines")
    component = models.ForeignKey(SalaryComponent, on_delete=models.PROTECT, related_name="+")
    amount = MoneyField(null=True, blank=True)
    rate_pct = PercentField(null=True, blank=True)

    class Meta:
        db_table = "hr_salary_structure_lines"
        constraints = [
            models.UniqueConstraint(fields=["structure", "component"], name="uq_hr_structure_component"),
        ]


class EmployeeSalary(EmployeeScopedModel, VersionedModel):
    """Salary assignment. SENSITIVE: readable only with `hr.salary.read` (MFA-protected)."""

    structure = models.ForeignKey(SalaryStructure, on_delete=models.PROTECT, related_name="+")
    effective_from = models.DateField()
    currency = models.CharField(max_length=3, default="INR")
    notes = models.CharField(max_length=300, blank=True)

    authz_resource_type = "hr.salary"

    class Meta:
        db_table = "hr_employee_salaries"
        constraints = [
            models.UniqueConstraint(fields=["employee", "effective_from"], name="uq_hr_employee_salary_from"),
        ]


class EmployeeSalaryLine(UUIDModel):
    """Monthly amount of a fixed component for this employee (overrides the structure default)."""

    salary = models.ForeignKey(EmployeeSalary, on_delete=models.CASCADE, related_name="lines")
    component = models.ForeignKey(SalaryComponent, on_delete=models.PROTECT, related_name="+")
    amount = MoneyField()

    class Meta:
        db_table = "hr_employee_salary_lines"
        constraints = [
            models.UniqueConstraint(fields=["salary", "component"], name="uq_hr_employee_salary_component"),
            models.CheckConstraint(condition=Q(amount__gte=0), name="ck_hr_employee_salary_amount"),
        ]


# --- Payroll runs -------------------------------------------------------------------------------------


class PayrollRun(CompanyScopedModel, VersionedModel):
    """draft -> computed -> submitted -> approved -> posted (rejected runs are recomputed)."""

    number = models.CharField(max_length=40, blank=True)
    year = models.PositiveSmallIntegerField()
    month = models.PositiveSmallIntegerField()
    period_start = models.DateField()
    period_end = models.DateField()
    status = models.CharField(max_length=20, default="draft")
    employee_count = models.PositiveIntegerField(default=0)
    gross_total = MoneyField(default=0)
    deduction_total = MoneyField(default=0)
    employer_total = MoneyField(default=0)
    net_total = MoneyField(default=0)
    amount = MoneyField(default=0)  # total cost (gross + employer contributions): approval limits apply
    currency = models.CharField(max_length=3, default="INR")
    computed_at = models.DateTimeField(null=True, blank=True)
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    posted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    posted_at = models.DateTimeField(null=True, blank=True)
    posting_date = models.DateField(null=True, blank=True)
    journal_entry = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "hr.payroll_run"

    class Meta:
        db_table = "hr_payroll_runs"
        constraints = [
            # One live run per month; a reversed run makes way for its corrected re-run.
            models.UniqueConstraint(
                fields=["company", "year", "month"],
                condition=~Q(status="reversed"),
                name="uq_hr_payroll_run_period",
            ),
            models.CheckConstraint(condition=Q(month__gte=1, month__lte=12), name="ck_hr_payroll_run_month"),
        ]


class Payslip(CompanyScopedModel):
    """One employee's pay for a run. `department` is the department at computation time."""

    run = models.ForeignKey(PayrollRun, on_delete=models.CASCADE, related_name="payslips")
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name="+")
    department = models.ForeignKey("organization.Department", on_delete=models.PROTECT, related_name="+")
    salary = models.ForeignKey(EmployeeSalary, on_delete=models.PROTECT, related_name="+")
    cost_center = models.ForeignKey(
        "finance.CostCenter", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    days_in_period = models.DecimalField(**DAYS)
    present_days = models.DecimalField(default=0, **DAYS)
    paid_leave_days = models.DecimalField(default=0, **DAYS)
    holiday_days = models.DecimalField(default=0, **DAYS)
    paid_days = models.DecimalField(default=0, **DAYS)
    lop_days = models.DecimalField(default=0, **DAYS)
    gross = MoneyField(default=0)
    total_deductions = MoneyField(default=0)
    employer_contributions = MoneyField(default=0)
    net_pay = MoneyField(default=0)

    authz_resource_type = "hr.payslip"
    authz_scope_fields = {"company": "company_id", "department": "department_id"}

    class Meta:
        db_table = "hr_payslips"
        constraints = [
            models.UniqueConstraint(fields=["run", "employee"], name="uq_hr_payslip_run_employee"),
            models.CheckConstraint(condition=Q(net_pay__gte=0), name="ck_hr_payslip_net_non_negative"),
        ]

    @property
    def status(self) -> str:
        return self.run.status


class PayslipLine(UUIDModel):
    payslip = models.ForeignKey(Payslip, on_delete=models.CASCADE, related_name="lines")
    component = models.ForeignKey(SalaryComponent, on_delete=models.PROTECT, related_name="+")
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=100)
    kind = models.CharField(max_length=25)
    is_statutory = models.BooleanField(default=False)
    base_amount = MoneyField(default=0)  # full-month amount, or the percentage base after ceilings
    rate_pct = PercentField(null=True, blank=True)
    amount = MoneyField()
    expense_key = models.CharField(max_length=40, blank=True)
    liability_key = models.CharField(max_length=40, blank=True)

    class Meta:
        db_table = "hr_payslip_lines"
        constraints = [models.CheckConstraint(condition=Q(amount__gte=0), name="ck_hr_payslip_line_amount")]
