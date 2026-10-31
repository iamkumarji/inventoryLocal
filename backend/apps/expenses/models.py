"""Expenses: claims, fuel logs and employee advances (SRS module 10).

Category limits and receipt thresholds are data on ExpenseCategory, never code.
"""

from django.conf import settings
from django.db import models
from django.db.models import F, Q

from apps.core.fields import MoneyField, QuantityField, RateField
from apps.core.models import CompanyScopedModel, UUIDModel, VersionedModel


class ExpenseCategory(CompanyScopedModel, VersionedModel):
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=100)
    gl_key = models.CharField(max_length=40, default="expense_default")  # GL determination key
    per_claim_limit = MoneyField(null=True, blank=True)  # max total of this category on one claim
    receipt_required_above = MoneyField(null=True, blank=True)  # a line above this needs a receipt
    requires_vehicle = models.BooleanField(default=False)  # fuel: vehicle, odometer and litres required
    is_active = models.BooleanField(default=True)

    authz_resource_type = "expenses.expense_category"

    class Meta:
        db_table = "expense_categories"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_expense_category_code"),
            models.CheckConstraint(
                condition=Q(per_claim_limit__isnull=True) | Q(per_claim_limit__gte=0), name="ck_expense_category_limit"
            ),
        ]


class EmployeeAdvance(CompanyScopedModel, VersionedModel):
    """requested -> approved | rejected; approved -> paid -> settled (by approved claims)."""

    number = models.CharField(max_length=40, blank=True)
    employee = models.ForeignKey("hr.Employee", on_delete=models.PROTECT, related_name="+")
    department = models.ForeignKey("organization.Department", on_delete=models.PROTECT, related_name="+")
    branch = models.ForeignKey("organization.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    amount = MoneyField()
    currency = models.CharField(max_length=3, default="INR")
    purpose = models.CharField(max_length=300)
    status = models.CharField(max_length=20, default="requested")
    settled_amount = MoneyField(default=0)
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    paid_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    paid_on = models.DateField(null=True, blank=True)
    bank_reference = models.CharField(max_length=60, blank=True)
    payment_journal = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "expenses.employee_advance"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id", "department": "department_id"}

    class Meta:
        db_table = "employee_advances"
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="ck_advance_amount"),
            models.CheckConstraint(
                condition=Q(settled_amount__gte=0, settled_amount__lte=F("amount")), name="ck_advance_settled"
            ),
        ]

    @property
    def outstanding(self):
        return self.amount - self.settled_amount


class ExpenseClaim(CompanyScopedModel, VersionedModel):
    """draft -> submitted -> approved | rejected -> paid. Approval posts the expense journal."""

    number = models.CharField(max_length=40, blank=True)
    employee = models.ForeignKey("hr.Employee", on_delete=models.PROTECT, related_name="+")
    department = models.ForeignKey("organization.Department", on_delete=models.PROTECT, related_name="+")
    branch = models.ForeignKey("organization.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    cost_center = models.ForeignKey(
        "finance.CostCenter", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    claim_date = models.DateField()
    purpose = models.CharField(max_length=300)
    status = models.CharField(max_length=20, default="draft")
    amount = MoneyField(default=0)
    currency = models.CharField(max_length=3, default="INR")
    advance = models.ForeignKey(EmployeeAdvance, null=True, blank=True, on_delete=models.PROTECT, related_name="claims")
    advance_settled = MoneyField(default=0)
    net_payable = MoneyField(default=0)
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    approval_journal = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    paid_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    paid_on = models.DateField(null=True, blank=True)
    bank_reference = models.CharField(max_length=60, blank=True)
    payment_journal = models.ForeignKey(
        "finance.JournalEntry", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "expenses.expense_claim"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id", "department": "department_id"}

    class Meta:
        db_table = "expense_claims"
        constraints = [
            models.CheckConstraint(condition=Q(amount__gte=0), name="ck_expense_claim_amount"),
            models.CheckConstraint(
                condition=Q(advance_settled__gte=0, advance_settled__lte=F("amount")),
                name="ck_expense_claim_advance_settled",
            ),
        ]
        indexes = [models.Index(fields=["company", "status"], name="ix_expense_claim_status")]


class ExpenseClaimLine(UUIDModel):
    claim = models.ForeignKey(ExpenseClaim, on_delete=models.CASCADE, related_name="lines")
    line_no = models.PositiveSmallIntegerField()
    category = models.ForeignKey(ExpenseCategory, on_delete=models.PROTECT, related_name="+")
    expense_date = models.DateField()
    description = models.CharField(max_length=300)
    amount = MoneyField()
    receipt_reference = models.CharField(max_length=100, blank=True)  # documents-module ID or file reference
    vehicle_registration = models.CharField(max_length=20, blank=True)
    odometer = QuantityField(null=True, blank=True)
    litres = QuantityField(null=True, blank=True)

    class Meta:
        db_table = "expense_claim_lines"
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="ck_expense_line_amount"),
            models.UniqueConstraint(fields=["claim", "line_no"], name="uq_expense_line_no"),
        ]


class FuelLog(CompanyScopedModel):
    """Odometer readings are monotonic per vehicle (checked under a per-vehicle lock)."""

    vehicle_registration = models.CharField(max_length=20)
    log_date = models.DateField()
    odometer = QuantityField()
    litres = QuantityField()
    rate = RateField()
    amount = MoneyField()
    driver = models.ForeignKey("hr.Employee", on_delete=models.PROTECT, related_name="+")
    department = models.ForeignKey("organization.Department", on_delete=models.PROTECT, related_name="+")
    claim_line = models.OneToOneField(
        ExpenseClaimLine, null=True, blank=True, on_delete=models.PROTECT, related_name="fuel_log"
    )
    remarks = models.CharField(max_length=300, blank=True)

    authz_resource_type = "expenses.fuel_log"
    authz_scope_fields = {"company": "company_id", "department": "department_id"}

    class Meta:
        db_table = "fuel_logs"
        constraints = [
            models.CheckConstraint(condition=Q(litres__gt=0, odometer__gte=0, rate__gte=0), name="ck_fuel_log_values"),
            models.UniqueConstraint(
                fields=["company", "vehicle_registration", "odometer"], name="uq_fuel_log_vehicle_odometer"
            ),
        ]
        indexes = [models.Index(fields=["company", "vehicle_registration", "log_date"], name="ix_fuel_log_vehicle")]
