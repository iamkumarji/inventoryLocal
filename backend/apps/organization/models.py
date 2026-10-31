from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import DateRangeField, RangeOperators
from django.db import models
from django.db.models import F, Func, Q

from apps.core.models import ActorStampedModel, AuthzResourceMixin, UUIDModel, VersionedModel


class Organization(AuthzResourceMixin, ActorStampedModel):
    """The business group that owns this installation (normally exactly one row)."""

    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=200)
    base_currency = models.CharField(max_length=3, default="INR")
    timezone = models.CharField(max_length=64, default="Asia/Kolkata")
    is_active = models.BooleanField(default=True)
    # Security policy, set by the organization's administrators (docs/RBAC_ABAC.md §8).
    require_mfa_for_all = models.BooleanField(default=False)  # every user must enrol two-step sign-in
    require_mfa_for_sensitive_actions = models.BooleanField(default=True)  # step-up before MFA-marked actions

    authz_resource_type = "organization.organization"
    authz_scope_fields = {"organization": "id"}

    class Meta:
        db_table = "organizations"

    def __str__(self) -> str:
        return self.name


GSTIN_REGEX = r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"
PAN_REGEX = r"^[A-Z]{5}[0-9]{4}[A-Z]$"


class Company(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    """A legal entity: books of account, GST registration and fiscal calendar are per company."""

    organization = models.ForeignKey(Organization, on_delete=models.PROTECT, related_name="companies")
    code = models.CharField(max_length=30)
    legal_name = models.CharField(max_length=250)
    trade_name = models.CharField(max_length=250, blank=True)
    gstin = models.CharField(max_length=15, blank=True)
    pan = models.CharField(max_length=10, blank=True)
    cin = models.CharField(max_length=21, blank=True)
    state_code = models.CharField(max_length=2, blank=True)
    base_currency = models.CharField(max_length=3, default="INR")
    fiscal_year_start_month = models.PositiveSmallIntegerField(default=4)
    timezone = models.CharField(max_length=64, default="Asia/Kolkata")
    address = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "organization.company"
    authz_scope_fields = {"organization": "organization_id", "company": "id"}

    class Meta:
        db_table = "companies"
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uq_company_org_code"),
            models.CheckConstraint(condition=Q(gstin="") | Q(gstin__regex=GSTIN_REGEX), name="ck_company_gstin"),
            models.CheckConstraint(condition=Q(pan="") | Q(pan__regex=PAN_REGEX), name="ck_company_pan"),
            models.CheckConstraint(
                condition=Q(fiscal_year_start_month__gte=1, fiscal_year_start_month__lte=12),
                name="ck_company_fy_month",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} - {self.legal_name}"


class Branch(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    company = models.ForeignKey(Company, on_delete=models.PROTECT, related_name="branches")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=200)
    gstin = models.CharField(max_length=15, blank=True)
    state_code = models.CharField(max_length=2, blank=True)
    address = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "organization.branch"
    authz_scope_fields = {"company": "company_id", "branch": "id"}

    class Meta:
        db_table = "branches"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_branch_company_code"),
            models.CheckConstraint(condition=Q(gstin="") | Q(gstin__regex=GSTIN_REGEX), name="ck_branch_gstin"),
        ]

    def __str__(self) -> str:
        return f"{self.code} - {self.name}"


class Department(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    company = models.ForeignKey(Company, on_delete=models.PROTECT, related_name="departments")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=200)
    head_user = models.ForeignKey("identity.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    is_active = models.BooleanField(default=True)

    authz_resource_type = "organization.department"
    authz_scope_fields = {"company": "company_id", "department": "id"}

    class Meta:
        db_table = "departments"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_department_company_code"),
            models.CheckConstraint(condition=~Q(parent=F("id")), name="ck_department_not_own_parent"),
        ]

    def __str__(self) -> str:
        return f"{self.code} - {self.name}"


class Facility(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    class FacilityType(models.TextChoices):
        PLANT = "plant"
        WAREHOUSE_SITE = "warehouse_site"
        OFFICE = "office"
        YARD = "yard"

    company = models.ForeignKey(Company, on_delete=models.PROTECT, related_name="facilities")
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name="facilities")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=200)
    facility_type = models.CharField(max_length=20, choices=FacilityType.choices)
    address = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "organization.facility"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id", "facility": "id"}

    class Meta:
        db_table = "facilities"
        verbose_name_plural = "facilities"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_facility_company_code"),
            models.CheckConstraint(
                condition=Q(facility_type__in=["plant", "warehouse_site", "office", "yard"]), name="ck_facility_type"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} - {self.name}"


class Warehouse(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    class WarehouseType(models.TextChoices):
        RAW_MATERIAL = "raw_material"
        WIP = "wip"
        FINISHED_GOODS = "finished_goods"
        QUARANTINE = "quarantine"
        SCRAP = "scrap"
        TRANSIT = "transit"
        GENERAL = "general"

    company = models.ForeignKey(Company, on_delete=models.PROTECT, related_name="warehouses")
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name="warehouses")
    facility = models.ForeignKey(Facility, null=True, blank=True, on_delete=models.PROTECT, related_name="warehouses")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=200)
    warehouse_type = models.CharField(max_length=20, choices=WarehouseType.choices)
    allow_negative_stock = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "organization.warehouse"
    authz_scope_fields = {"company": "company_id", "branch": "branch_id", "facility": "facility_id", "warehouse": "id"}

    class Meta:
        db_table = "warehouses"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_warehouse_company_code"),
            models.CheckConstraint(
                condition=Q(
                    warehouse_type__in=[
                        "raw_material",
                        "wip",
                        "finished_goods",
                        "quarantine",
                        "scrap",
                        "transit",
                        "general",
                    ]
                ),
                name="ck_warehouse_type",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} - {self.name}"


class DateRange(Func):
    function = "DATERANGE"
    output_field = DateRangeField()


class FiscalYear(AuthzResourceMixin, ActorStampedModel):
    class Status(models.TextChoices):
        OPEN = "open"
        CLOSING = "closing"
        CLOSED = "closed"

    company = models.ForeignKey(Company, on_delete=models.PROTECT, related_name="fiscal_years")
    code = models.CharField(max_length=20)
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN)

    authz_resource_type = "organization.fiscal_year"
    authz_scope_fields = {"company": "company_id"}

    class Meta:
        db_table = "fiscal_years"
        constraints = [
            models.UniqueConstraint(fields=["company", "code"], name="uq_fiscal_year_company_code"),
            models.CheckConstraint(condition=Q(end_date__gt=F("start_date")), name="ck_fiscal_year_dates"),
            models.CheckConstraint(condition=Q(status__in=["open", "closing", "closed"]), name="ck_fiscal_year_status"),
            ExclusionConstraint(
                name="ex_fiscal_year_overlap",
                expressions=[
                    (F("company"), RangeOperators.EQUAL),
                    (DateRange("start_date", "end_date", models.Value("[]")), RangeOperators.OVERLAPS),
                ],
            ),
        ]

    def __str__(self) -> str:
        return self.code


class FiscalPeriod(UUIDModel):
    class Status(models.TextChoices):
        OPEN = "open"
        SOFT_CLOSED = "soft_closed"
        CLOSED = "closed"

    fiscal_year = models.ForeignKey(FiscalYear, on_delete=models.CASCADE, related_name="periods")
    period_no = models.PositiveSmallIntegerField()
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.OPEN)
    # Per-module locks: a period can be closed for inventory while still open for GL adjustments.
    inventory_locked = models.BooleanField(default=False)
    ap_locked = models.BooleanField(default=False)
    ar_locked = models.BooleanField(default=False)
    gl_locked = models.BooleanField(default=False)

    class Meta:
        db_table = "fiscal_periods"
        ordering = ["period_no"]
        constraints = [
            models.UniqueConstraint(fields=["fiscal_year", "period_no"], name="uq_fiscal_period_no"),
            models.CheckConstraint(condition=Q(end_date__gte=F("start_date")), name="ck_fiscal_period_dates"),
            models.CheckConstraint(
                condition=Q(status__in=["open", "soft_closed", "closed"]), name="ck_fiscal_period_status"
            ),
        ]


class DocumentSequence(UUIDModel):
    """Gapless numbering per company, series and fiscal year (row-locked on allocation)."""

    company = models.ForeignKey(Company, on_delete=models.PROTECT, related_name="+")
    series_code = models.CharField(max_length=20)
    fiscal_year = models.ForeignKey(FiscalYear, on_delete=models.PROTECT, related_name="+")
    prefix = models.CharField(max_length=20)
    padding = models.PositiveSmallIntegerField(default=6)
    next_value = models.PositiveBigIntegerField(default=1)

    class Meta:
        db_table = "document_sequences"
        constraints = [
            models.UniqueConstraint(fields=["company", "series_code", "fiscal_year"], name="uq_document_sequence"),
            models.CheckConstraint(condition=Q(next_value__gte=1), name="ck_document_sequence_positive"),
        ]
