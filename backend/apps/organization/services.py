"""Organization structure, fiscal calendar and document numbering services."""

from __future__ import annotations

import calendar
from datetime import date

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Model
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import BusinessRuleViolation, MFARequired, NotFound, VersionConflict

from .models import (
    Branch,
    Company,
    Department,
    DocumentSequence,
    Facility,
    FiscalPeriod,
    FiscalYear,
    Organization,
    Warehouse,
)

# Fields each model allows to change after creation (codes are immutable identifiers).
EDITABLE_FIELDS: dict[type[Model], tuple[str, ...]] = {
    Company: ("legal_name", "trade_name", "gstin", "pan", "cin", "state_code", "timezone", "address", "is_active"),
    Branch: ("name", "gstin", "state_code", "address", "is_active"),
    Department: ("name", "parent", "head_user", "is_active"),
    Facility: ("name", "facility_type", "address", "is_active"),
    Warehouse: ("name", "warehouse_type", "facility", "allow_negative_stock", "is_active"),
}


def _audit_fields(model: type[Model]) -> tuple[str, ...]:
    return ("code", *EDITABLE_FIELDS[model])


def _create(ctx: ActorContext, model: type[Model], resource: pdp.Resource, **fields) -> Model:
    pdp.require(ctx, f"{model.authz_resource_type}.create", resource)
    instance = model(**fields, created_by=ctx.user, updated_by=ctx.user)
    instance.full_clean(exclude=["created_by", "updated_by"], validate_unique=False, validate_constraints=False)
    try:
        with transaction.atomic():
            instance.save()
    except IntegrityError as exc:
        if "uq_" in str(exc):
            raise ValidationError({"code": ["This code is already in use."]}) from exc
        raise
    audit.record(
        f"{model.authz_resource_type}.created",
        ctx=ctx,
        resource_type=model.authz_resource_type,
        resource_id=instance.pk,
        company_id=getattr(instance, "company_id", None),
        changes={"after": audit.snapshot(instance, _audit_fields(model))},
    )
    return instance


@transaction.atomic
def update_node(ctx: ActorContext, instance: Model, data: dict, expected_version: int | None) -> Model:
    model = type(instance)
    instance = model.objects.select_for_update().get(pk=instance.pk)
    action = "update"
    if "allow_negative_stock" in data and data["allow_negative_stock"] != getattr(
        instance, "allow_negative_stock", None
    ):
        action = "manage"  # changing stock policy is an administrative permission
    pdp.require(ctx, f"{model.authz_resource_type}.{action}", pdp.Resource.of(instance))
    if expected_version is None or instance.version != expected_version:
        raise VersionConflict()
    unknown = set(data) - set(EDITABLE_FIELDS[model])
    if unknown:
        raise ValidationError({field: ["This field cannot be changed."] for field in sorted(unknown)})
    before = audit.snapshot(instance, _audit_fields(model))
    for field, value in data.items():
        setattr(instance, field, value)
    _validate_relations(instance)
    instance.version += 1
    instance.updated_by = ctx.user
    instance.full_clean(exclude=["created_by", "updated_by"], validate_unique=False, validate_constraints=False)
    instance.save()
    changes = audit.diff(before, audit.snapshot(instance, _audit_fields(model)))
    if changes:
        audit.record(
            f"{model.authz_resource_type}.updated",
            ctx=ctx,
            resource_type=model.authz_resource_type,
            resource_id=instance.pk,
            company_id=getattr(instance, "company_id", None),
            changes=changes,
        )
    return instance


def _validate_relations(instance: Model) -> None:
    if isinstance(instance, Department) and instance.parent_id:
        if instance.parent.company_id != instance.company_id:
            raise ValidationError({"parent": ["Parent department must belong to the same company."]})
        ancestor, seen = instance.parent, set()
        while ancestor is not None:
            if ancestor.pk == instance.pk or ancestor.pk in seen:
                raise ValidationError({"parent": ["Department hierarchy cannot contain cycles."]})
            seen.add(ancestor.pk)
            ancestor = ancestor.parent
    if isinstance(instance, Warehouse) and instance.facility_id:
        if instance.facility.branch_id != instance.branch_id:
            raise ValidationError({"facility": ["Facility must belong to the warehouse's branch."]})


# --- Creation ---------------------------------------------------------------------------


def create_organization(
    ctx: ActorContext, *, code: str, name: str, base_currency: str = "INR", timezone: str = "Asia/Kolkata"
) -> Organization:
    if not ctx.is_system:
        raise BusinessRuleViolation("Organizations are created during installation only.", code="system_only")
    org = Organization.objects.create(code=code, name=name, base_currency=base_currency, timezone=timezone)
    audit.record(
        "organization.organization.created",
        ctx=ctx,
        resource_type="organization.organization",
        resource_id=org.pk,
        organization_id=org.pk,
        changes={"code": code, "name": name},
    )
    return org


def create_company(ctx: ActorContext, *, organization: Organization, **fields) -> Company:
    return _create(
        ctx,
        Company,
        pdp.Resource.ref("organization.company", organization_id=organization.pk),
        organization=organization,
        **fields,
    )


def create_branch(ctx: ActorContext, *, company: Company, **fields) -> Branch:
    return _create(
        ctx, Branch, pdp.Resource.ref("organization.branch", company_id=company.pk), company=company, **fields
    )


def create_department(ctx: ActorContext, *, company: Company, parent: Department | None = None, **fields) -> Department:
    if parent is not None and parent.company_id != company.pk:
        raise ValidationError({"parent": ["Parent department must belong to the same company."]})
    resource = pdp.Resource.ref(
        "organization.department", company_id=company.pk, department_id=parent.pk if parent else None
    )
    return _create(ctx, Department, resource, company=company, parent=parent, **fields)


def create_facility(ctx: ActorContext, *, branch: Branch, **fields) -> Facility:
    resource = pdp.Resource.ref("organization.facility", company_id=branch.company_id, branch_id=branch.pk)
    return _create(ctx, Facility, resource, company_id=branch.company_id, branch=branch, **fields)


def create_warehouse(ctx: ActorContext, *, branch: Branch, facility: Facility | None = None, **fields) -> Warehouse:
    if facility is not None and facility.branch_id != branch.pk:
        raise ValidationError({"facility": ["Facility must belong to the warehouse's branch."]})
    if fields.get("allow_negative_stock"):
        pdp.require(
            ctx,
            "organization.warehouse.manage",
            pdp.Resource.ref("organization.warehouse", company_id=branch.company_id, branch_id=branch.pk),
        )
    resource = pdp.Resource.ref(
        "organization.warehouse",
        company_id=branch.company_id,
        branch_id=branch.pk,
        facility_id=facility.pk if facility else None,
    )
    return _create(ctx, Warehouse, resource, company_id=branch.company_id, branch=branch, facility=facility, **fields)


# --- Fiscal calendar ---------------------------------------------------------------------


def _add_months(start: date, months: int) -> date:
    month_index = start.month - 1 + months
    year, month = start.year + month_index // 12, month_index % 12 + 1
    return date(year, month, min(start.day, calendar.monthrange(year, month)[1]))


def fiscal_year_code(start: date, end: date) -> str:
    return f"FY{start.year}" if start.year == end.year else f"FY{start.year}-{str(end.year)[-2:]}"


@transaction.atomic
def create_fiscal_year(ctx: ActorContext, *, company: Company, start_year: int) -> FiscalYear:
    """Create a 12-month fiscal year starting in the company's configured month, with monthly periods."""
    pdp.require(
        ctx, "organization.fiscal_year.create", pdp.Resource.ref("organization.fiscal_year", company_id=company.pk)
    )
    start = date(start_year, company.fiscal_year_start_month, 1)
    next_start = _add_months(start, 12)
    end = date.fromordinal(next_start.toordinal() - 1)
    if FiscalYear.objects.filter(company=company, start_date__lte=end, end_date__gte=start).exists():
        raise BusinessRuleViolation("Fiscal year overlaps an existing one.", code="fiscal_year_overlap")
    fy = FiscalYear.objects.create(
        company=company,
        code=fiscal_year_code(start, end),
        start_date=start,
        end_date=end,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    periods = []
    for number in range(12):
        p_start = _add_months(start, number)
        p_end = date.fromordinal(_add_months(start, number + 1).toordinal() - 1)
        periods.append(FiscalPeriod(fiscal_year=fy, period_no=number + 1, start_date=p_start, end_date=p_end))
    FiscalPeriod.objects.bulk_create(periods)
    audit.record(
        "organization.fiscal_year.created",
        ctx=ctx,
        resource_type="organization.fiscal_year",
        resource_id=fy.pk,
        company_id=company.pk,
        changes={"code": fy.code, "start": start.isoformat(), "end": end.isoformat()},
    )
    return fy


def fiscal_year_for(company_id, on_date: date) -> FiscalYear:
    fy = FiscalYear.objects.filter(company_id=company_id, start_date__lte=on_date, end_date__gte=on_date).first()
    if fy is None:
        raise BusinessRuleViolation(f"No fiscal year covers {on_date.isoformat()}.", code="fiscal_year_missing")
    return fy


def period_for(company_id, on_date: date) -> FiscalPeriod:
    period = (
        FiscalPeriod.objects.select_related("fiscal_year")
        .filter(fiscal_year__company_id=company_id, start_date__lte=on_date, end_date__gte=on_date)
        .first()
    )
    if period is None:
        raise BusinessRuleViolation(f"No fiscal period covers {on_date.isoformat()}.", code="fiscal_period_missing")
    return period


def ensure_period_open(company_id, on_date: date, module: str) -> FiscalPeriod:
    """Posting guard used by inventory/finance services. `module` in {inventory, ap, ar, gl}."""
    period = period_for(company_id, on_date)
    if period.status == FiscalPeriod.Status.CLOSED or period.fiscal_year.status == FiscalYear.Status.CLOSED:
        raise BusinessRuleViolation("The accounting period is closed.", code="period_closed")
    if getattr(period, f"{module}_locked"):
        raise BusinessRuleViolation(f"The period is locked for {module} postings.", code="period_locked")
    return period


# --- Document numbering ------------------------------------------------------------------


def allocate_number(company_id, series_code: str, on_date: date, *, prefix: str | None = None, padding: int = 6) -> str:
    """Allocate the next gapless number. Must run inside the posting transaction.

    The sequence row stays locked until commit, so numbers are only consumed by
    transactions that commit (a rollback releases the number).
    """
    from django.db import connection

    if not connection.in_atomic_block:
        raise RuntimeError("allocate_number must be called inside transaction.atomic()")
    fy = fiscal_year_for(company_id, on_date)
    DocumentSequence.objects.get_or_create(
        company_id=company_id,
        series_code=series_code,
        fiscal_year=fy,
        defaults={"prefix": prefix or series_code, "padding": padding},
    )
    sequence = DocumentSequence.objects.select_for_update().get(
        company_id=company_id, series_code=series_code, fiscal_year=fy
    )
    value = sequence.next_value
    sequence.next_value = value + 1
    sequence.save(update_fields=["next_value"])
    short_fy = fy.code.removeprefix("FY")
    return f"{sequence.prefix}/{short_fy}/{value:0{sequence.padding}d}"


def get_node(model: type[Model], pk) -> Model:
    try:
        return model.objects.get(pk=pk)
    except (model.DoesNotExist, ValueError, ValidationError) as exc:
        raise NotFound() from exc


SECURITY_FIELDS = ("require_mfa_for_all", "require_mfa_for_sensitive_actions")


@transaction.atomic
def update_security_settings(ctx: ActorContext, organization: Organization, **changes) -> Organization:
    """Organization-wide two-step sign-in policy. Relaxing it needs a recently verified administrator
    (when they use MFA themselves) and is audited."""
    organization = Organization.objects.select_for_update().get(pk=organization.pk)
    pdp.require(ctx, "organization.organization.update", pdp.Resource.of(organization))
    changes = {k: bool(v) for k, v in changes.items() if k in SECURITY_FIELDS}
    relaxing = any(getattr(organization, k) and not v for k, v in changes.items())
    if relaxing and _uses_mfa(ctx.user) and not ctx.mfa_verified_within(settings.ERP["STEP_UP_MINUTES"]):
        raise MFARequired()
    before = {k: getattr(organization, k) for k in SECURITY_FIELDS}
    for key, value in changes.items():
        setattr(organization, key, value)
    organization.save(update_fields=[*changes, "updated_at"])
    audit.record(
        "organization.security_settings.updated",
        ctx=ctx,
        resource_type="organization.organization",
        resource_id=organization.pk,
        organization_id=organization.pk,
        summary="Two-step sign-in policy changed",
        changes=audit.diff(before, {k: getattr(organization, k) for k in SECURITY_FIELDS}),
    )
    return organization


def _uses_mfa(user) -> bool:
    from django.apps import apps as django_apps

    device = django_apps.get_model("identity", "MFADevice")
    return device.objects.filter(user=user, confirmed_at__isnull=False).exists()
