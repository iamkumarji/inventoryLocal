"""Fixed assets (SRS asset module, D-25): capitalization, monthly depreciation, disposal and maintenance.

Accounting goes through `finance.posting.post_journal` and stock through `inventory.engine.post_stock`,
inside the business transaction owned by the service. GL accounts come from determination keys
(`fixed_assets`, `accumulated_depreciation`, `depreciation_expense`, `default_bank`, `expense_default`,
`maintenance_expense`, optional `other_income`) or from per-category overrides; no codes are hardcoded.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import IntegrityError, transaction
from django.db.models import Exists, OuterRef, Sum
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core import flags
from apps.core.context import ActorContext
from apps.core.exceptions import BusinessRuleViolation, InvalidStateTransition, VersionConflict
from apps.core.outbox import publish_event
from apps.finance.models import Account
from apps.finance.posting import Line, post_journal, resolve_account, reverse_journal
from apps.inventory.engine import Move, get_or_create_batch, post_stock
from apps.notifications import services as notifications
from apps.organization.models import Company
from apps.organization.services import allocate_number
from apps.shared import workflow

from .models import (
    Asset,
    AssetCategory,
    DepreciationEntry,
    DepreciationMethod,
    DepreciationRun,
    MaintenancePlan,
    MaintenanceWorkOrder,
    MeterReading,
    WorkOrderSpare,
)

ASSET = "assets.asset"
RUN = "assets.depreciation_run"
PLAN = "assets.maintenance_plan"
WO = "assets.work_order"
METER = "assets.meter_reading"
SOURCE_MODULE = "assets"
Q2 = Decimal("0.01")
ZERO = Decimal("0")
HUNDRED = Decimal("100")
MONTHS_PER_YEAR = Decimal("12")
MINUTES_PER_HOUR = Decimal("60")

# Fields a client may change, by lifecycle stage. Values that drive the books are frozen once capitalized.
DRAFT_EDITABLE = (
    "name",
    "serial_number",
    "custodian",
    "location",
    "acquisition_date",
    "put_to_use_date",
    "capitalization_date",
    "cost",
    "salvage_value",
    "depreciation_method",
    "useful_life_months",
    "wdv_rate",
    "contra_account",
    "contra_partner",
    "category",
    "facility",
)
IN_SERVICE_EDITABLE = ("name", "serial_number", "custodian", "location")


def _audit(ctx, action, obj, summary="", changes=None, resource_type=None):
    audit.record(
        action,
        ctx=ctx,
        resource_type=resource_type or obj.authz_resource_type,
        resource_id=obj.pk,
        company_id=obj.company_id,
        summary=summary[:500],
        changes=changes,
    )


def _money(value) -> Decimal:
    return Decimal(value).quantize(Q2, rounding=ROUND_HALF_UP)


def month_bounds(day: date) -> tuple[date, date]:
    start = day.replace(day=1)
    return start, start.replace(day=calendar.monthrange(start.year, start.month)[1])


def _account_line(amount: Decimal, account: Account | None, key: str, description: str, **kw) -> Line:
    return Line(amount=amount, account=account, key=None if account else key, description=description[:300], **kw)


def _check_account(account: Account | None, company_id, field: str) -> None:
    if account is not None and account.company_id != company_id:
        raise ValidationError({field: ["Account belongs to another company."]})


def _check_user(user, company_id, field: str) -> None:
    """Custodians and technicians must be users of the company's organization."""
    if user is not None and user.organization_id != Company.objects.values_list("organization_id", flat=True).get(
        pk=company_id
    ):
        raise ValidationError({field: ["Choose a user of this organization."]})


# --- Categories -----------------------------------------------------------------------------------


def validate_category(data: dict, company_id) -> None:
    method = data.get("depreciation_method")
    if method == DepreciationMethod.SLM and not data.get("useful_life_months"):
        raise ValidationError({"useful_life_months": ["Straight-line depreciation needs a useful life."]})
    if method == DepreciationMethod.WDV and not (ZERO < Decimal(data.get("wdv_rate") or 0) <= HUNDRED):
        raise ValidationError({"wdv_rate": ["Written-down-value depreciation needs an annual rate (0-100%]."]})
    for field in ("fixed_asset_account", "accumulated_depreciation_account", "depreciation_expense_account"):
        _check_account(data.get(field), company_id, field)


# --- Assets ---------------------------------------------------------------------------------------


def _validate_asset(asset: Asset) -> None:
    if asset.category.company_id != asset.company_id or asset.facility.company_id != asset.company_id:
        raise ValidationError({"category": ["Category and facility must belong to the asset's company."]})
    if asset.depreciation_method == DepreciationMethod.SLM and not asset.useful_life_months:
        raise ValidationError({"useful_life_months": ["Straight-line depreciation needs a useful life."]})
    if asset.depreciation_method == DepreciationMethod.WDV and not (ZERO < asset.wdv_rate <= HUNDRED):
        raise ValidationError({"wdv_rate": ["Written-down-value depreciation needs an annual rate (0-100%]."]})
    if asset.cost <= 0:
        raise ValidationError({"cost": ["Cost must be positive."]})
    if not (ZERO <= asset.salvage_value < asset.cost):
        raise ValidationError({"salvage_value": ["Salvage value must be at least zero and below cost."]})
    if asset.put_to_use_date and asset.put_to_use_date < asset.acquisition_date:
        raise ValidationError({"put_to_use_date": ["An asset can't be put to use before it is acquired."]})
    _check_account(asset.contra_account, asset.company_id, "contra_account")


@transaction.atomic
def create_asset(
    ctx: ActorContext,
    *,
    company,
    facility,
    category: AssetCategory,
    code: str,
    name: str,
    acquisition_date: date,
    cost: Decimal,
    put_to_use_date: date | None = None,
    capitalization_date: date | None = None,
    salvage_value: Decimal | None = None,
    depreciation_method: str | None = None,
    useful_life_months: int | None = None,
    wdv_rate: Decimal | None = None,
    serial_number: str = "",
    custodian=None,
    location: str = "",
    contra_account: Account | None = None,
    contra_partner=None,
) -> Asset:
    pdp.require(ctx, f"{ASSET}.create", pdp.Resource.ref(ASSET, company_id=company.pk, facility_id=facility.pk))
    if not category.is_active:
        raise ValidationError({"category": ["This category is inactive."]})
    cost = Decimal(cost)
    asset = Asset(
        company=company,
        facility=facility,
        category=category,
        code=code,
        name=name,
        serial_number=serial_number,
        custodian=custodian,
        location=location,
        acquisition_date=acquisition_date,
        put_to_use_date=put_to_use_date,
        capitalization_date=capitalization_date,
        cost=cost,
        salvage_value=_money(cost * category.salvage_pct / HUNDRED)
        if salvage_value is None
        else Decimal(salvage_value),
        depreciation_method=depreciation_method or category.depreciation_method,
        useful_life_months=category.useful_life_months if useful_life_months is None else useful_life_months,
        wdv_rate=category.wdv_rate if wdv_rate is None else Decimal(wdv_rate),
        contra_account=contra_account,
        contra_partner=contra_partner,
        book_value=cost,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    _validate_asset(asset)
    _check_user(custodian, company.pk, "custodian")
    try:
        with transaction.atomic():
            asset.save()
    except IntegrityError as exc:
        raise ValidationError({"code": ["An asset with this code already exists."]}) from exc
    _audit(
        ctx,
        f"{ASSET}.created",
        asset,
        f"{asset.code} {asset.name}",
        {
            "after": audit.snapshot(
                asset,
                ("code", "name", "cost", "salvage_value", "depreciation_method", "useful_life_months", "wdv_rate"),
            )
        },
    )
    return asset


@transaction.atomic
def update_asset(ctx: ActorContext, asset: Asset, data: dict, expected_version: int | None) -> Asset:
    asset = Asset.objects.select_for_update(of=("self",)).select_related("category", "facility").get(pk=asset.pk)
    pdp.require(ctx, f"{ASSET}.update", pdp.Resource.of(asset))
    if expected_version is None or asset.version != expected_version:
        raise VersionConflict()
    if asset.status == Asset.Status.DISPOSED:
        raise InvalidStateTransition("Disposed assets can't be changed.")
    editable = DRAFT_EDITABLE if asset.status in (Asset.Status.DRAFT, Asset.Status.REJECTED) else IN_SERVICE_EDITABLE
    unknown = set(data) - set(editable)
    if unknown:
        raise ValidationError({f: ["This field can't be changed at this stage."] for f in sorted(unknown)})
    fields = editable
    before = audit.snapshot(asset, fields)
    for key, value in data.items():
        setattr(asset, key, value)
    if asset.status in (Asset.Status.DRAFT, Asset.Status.REJECTED):
        asset.book_value = asset.cost
    _validate_asset(asset)
    _check_user(asset.custodian, asset.company_id, "custodian")
    workflow.bump(asset, ctx)
    changes = audit.diff(before, audit.snapshot(asset, fields))
    if changes:
        _audit(ctx, f"{ASSET}.updated", asset, asset.code, changes)
    return asset


def _ready_to_capitalize(asset: Asset) -> None:
    if asset.put_to_use_date is None:
        raise ValidationError({"put_to_use_date": ["Set the put-to-use date before capitalizing."]})
    if asset.capitalization_date is None:
        asset.capitalization_date = asset.put_to_use_date


def _post_capitalization(ctx: ActorContext, asset: Asset) -> Asset:
    """Dr fixed assets / Cr contra (given account, else `default_bank`). Runs inside the caller's transaction."""
    _ready_to_capitalize(asset)
    category = asset.category
    label = f"{asset.code} {asset.name}"
    entry = post_journal(
        ctx,
        company_id=asset.company_id,
        entry_date=asset.capitalization_date,
        lines=[
            _account_line(asset.cost, category.fixed_asset_account, "fixed_assets", label),
            _account_line(-asset.cost, asset.contra_account, "default_bank", label, partner_id=asset.contra_partner_id),
        ],
        narration=f"Capitalization of {label}",
        source_module=SOURCE_MODULE,
        source_type=ASSET,
        source_id=asset.pk,
    )
    workflow.bump(
        asset,
        ctx,
        status=Asset.Status.CAPITALIZED,
        capitalization_journal=entry,
        capitalized_at=timezone.now(),
        book_value=asset.cost - asset.accumulated_depreciation,
        approved_by=ctx.user or asset.approved_by,
    )
    _audit(
        ctx,
        f"{ASSET}.capitalized",
        asset,
        f"{asset.code} capitalized at {asset.cost}",
        {"journal": entry.number, "cost": str(asset.cost), "date": asset.capitalization_date.isoformat()},
    )
    publish_event(
        "assets.asset.capitalized",
        aggregate_type=ASSET,
        aggregate_id=asset.pk,
        company_id=asset.company_id,
        payload={"cost": str(asset.cost)},
    )
    return asset


def _lock_asset(asset: Asset) -> Asset:
    return Asset.objects.select_for_update(of=("self",)).select_related("category").get(pk=asset.pk)


@transaction.atomic
def capitalize(ctx: ActorContext, asset: Asset, expected_version: int | None = None) -> Asset:
    """Direct capitalization by an approver whose approval limit covers the cost (not the maker).

    Above the limit the asset must be submitted (`submit_for_capitalization`) and approved through the
    approvals workflow; the approval posts the capitalization journal.
    """
    asset = _lock_asset(asset)
    workflow.check(asset, expected_version, Asset.Status.DRAFT, Asset.Status.REJECTED)
    _ready_to_capitalize(asset)
    decision = pdp.authorize(ctx, f"{ASSET}.approve", pdp.Resource.of(asset))
    if not decision.allowed and decision.reason == "approval_limit":
        raise BusinessRuleViolation(
            "The cost exceeds your approval limit. Submit the asset for approval.", code="approval_limit_exceeded"
        )
    pdp.require(ctx, f"{ASSET}.approve", pdp.Resource.of(asset))
    return _post_capitalization(ctx, asset)


def submit_for_capitalization(ctx: ActorContext, asset: Asset, expected_version: int | None = None) -> Asset:
    _ready_to_capitalize(asset)
    return workflow.submit(
        ctx,
        asset,
        document_type=ASSET,
        title=f"Capitalize asset {asset.code}: {asset.name}",
        summary={"cost": str(asset.cost), "category": asset.category.code},
        scope={"facility_id": asset.facility_id},
        expected_version=expected_version,
    )


@transaction.atomic
def decide_capitalization(
    ctx: ActorContext, asset: Asset, *, approve: bool, comment: str = "", expected_version: int | None = None
) -> Asset:
    """Single-approver decision when no approval route is configured; approval posts the journal."""
    asset = workflow.decide_directly(
        ctx, asset, document_type=ASSET, approve=approve, comment=comment, expected_version=expected_version
    )
    if approve:
        asset = _post_capitalization(ctx, _lock_asset(asset))
    return asset


def _on_route_approved(doc: Asset, ctx: ActorContext) -> None:
    _post_capitalization(ctx, _lock_asset(doc))


workflow.register(ASSET, Asset, "Fixed asset capitalization", "/assets/assets", on_approved=_on_route_approved)


# --- Depreciation ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class DepreciationLine:
    asset: Asset
    opening_book_value: Decimal
    amount: Decimal
    days: int

    @property
    def book_value_after(self) -> Decimal:
        return self.opening_book_value - self.amount

    def as_dict(self) -> dict:
        return {
            "asset": str(self.asset.pk),
            "asset_code": self.asset.code,
            "method": self.asset.depreciation_method,
            "opening_book_value": self.opening_book_value,
            "amount": self.amount,
            "book_value_after": self.book_value_after,
            "days": self.days,
        }


def monthly_depreciation(
    asset: Asset, period_start: date, period_end: date, opening_book_value: Decimal | None = None
) -> tuple[Decimal, int]:
    """Depreciation of one asset for one month: (amount, days depreciated).

    SLM = (cost - salvage) / useful life months; WDV = opening book value x annual rate / 12.
    The first month is pro-rated by days from the put-to-use date; book value never goes below salvage.
    """
    if asset.put_to_use_date is None or asset.put_to_use_date > period_end:
        return ZERO, 0
    opening = asset.cost - asset.accumulated_depreciation if opening_book_value is None else opening_book_value
    headroom = opening - asset.salvage_value
    if headroom <= 0:
        return ZERO, 0
    days_in_month = (period_end - period_start).days + 1
    days = (period_end - max(asset.put_to_use_date, period_start)).days + 1
    if asset.depreciation_method == DepreciationMethod.SLM:
        base = (asset.cost - asset.salvage_value) / Decimal(asset.useful_life_months)
    else:
        base = opening * asset.wdv_rate / HUNDRED / MONTHS_PER_YEAR
    amount = _money(base * Decimal(days) / Decimal(days_in_month))
    return min(amount, headroom), days


def _eligible_assets(company_id, period_start: date, period_end: date):
    already = DepreciationEntry.objects.filter(
        asset=OuterRef("pk"), period=period_start, run__status=DepreciationRun.Status.POSTED
    )
    return (
        Asset.objects.filter(
            company_id=company_id,
            status=Asset.Status.CAPITALIZED,
            put_to_use_date__lte=period_end,
            capitalization_date__lte=period_end,
        )
        .exclude(Exists(already))
        .select_related("category")
        .order_by("code")
    )


def compute_run(run: DepreciationRun, *, lock: bool = False) -> list[DepreciationLine]:
    start, end = month_bounds(run.period)
    assets = _eligible_assets(run.company_id, start, end)
    if lock:
        assets = assets.select_for_update(of=("self",))
    lines = []
    for asset in assets:
        amount, days = monthly_depreciation(asset, start, end)
        if amount > 0:
            lines.append(DepreciationLine(asset, asset.cost - asset.accumulated_depreciation, amount, days))
    return lines


def _live_runs(company_id):
    return DepreciationRun.objects.filter(
        company_id=company_id, status__in=[DepreciationRun.Status.DRAFT, DepreciationRun.Status.POSTED]
    )


@transaction.atomic
def create_run(ctx: ActorContext, *, company, period: date) -> DepreciationRun:
    pdp.require(ctx, f"{RUN}.create", pdp.Resource.ref(RUN, company_id=company.pk))
    period = period.replace(day=1)
    if _live_runs(company.pk).filter(period=period).exists():
        raise BusinessRuleViolation(
            f"A depreciation run for {period:%B %Y} already exists. Reverse it to re-run.",
            code="depreciation_run_exists",
        )
    if _live_runs(company.pk).filter(period__gt=period).exists():
        raise BusinessRuleViolation(
            "A later month has already been run. Reverse later runs first.", code="depreciation_out_of_sequence"
        )
    try:
        with transaction.atomic():
            run = DepreciationRun.objects.create(
                company=company, period=period, created_by=ctx.user, updated_by=ctx.user
            )
    except IntegrityError as exc:  # concurrent creation of the same month
        raise BusinessRuleViolation(
            f"A depreciation run for {period:%B %Y} already exists.", code="depreciation_run_exists"
        ) from exc
    _audit(ctx, f"{RUN}.created", run, f"Depreciation {period:%Y-%m}")
    return run


@transaction.atomic
def post_run(ctx: ActorContext, run: DepreciationRun, expected_version: int | None = None) -> DepreciationRun:
    """One balanced journal (Dr depreciation expense / Cr accumulated depreciation, one pair per asset)."""
    run = DepreciationRun.objects.select_for_update().get(pk=run.pk)
    workflow.check(run, expected_version, DepreciationRun.Status.DRAFT)
    pdp.require(ctx, f"{RUN}.post", pdp.Resource.of(run))
    start, end = month_bounds(run.period)
    lines = compute_run(run, lock=True)
    if not lines:
        raise BusinessRuleViolation(f"Nothing to depreciate for {start:%B %Y}.", code="nothing_to_depreciate")
    journal: list[Line] = []
    for ln in lines:
        category, label = ln.asset.category, f"{ln.asset.code} depreciation {start:%Y-%m}"
        journal += [
            _account_line(ln.amount, category.depreciation_expense_account, "depreciation_expense", label),
            _account_line(-ln.amount, category.accumulated_depreciation_account, "accumulated_depreciation", label),
        ]
    entry = post_journal(
        ctx,
        company_id=run.company_id,
        entry_date=end,
        lines=journal,
        narration=f"Depreciation for {start:%B %Y}",
        source_module=SOURCE_MODULE,
        source_type=RUN,
        source_id=run.pk,
    )
    DepreciationEntry.objects.bulk_create(
        [
            DepreciationEntry(
                run=run,
                asset=ln.asset,
                period=start,
                opening_book_value=ln.opening_book_value,
                amount=ln.amount,
                book_value_after=ln.book_value_after,
                days=ln.days,
            )
            for ln in lines
        ]
    )
    for ln in lines:
        asset = ln.asset
        asset.accumulated_depreciation += ln.amount
        asset.book_value = asset.cost - asset.accumulated_depreciation
        asset.version += 1
        asset.save(update_fields=["accumulated_depreciation", "book_value", "version", "updated_at"])
    total = sum((ln.amount for ln in lines), ZERO)
    workflow.bump(
        run,
        ctx,
        status=DepreciationRun.Status.POSTED,
        journal_entry=entry,
        total_amount=total,
        asset_count=len(lines),
        posted_by=ctx.user,
        posted_at=timezone.now(),
    )
    _audit(
        ctx,
        f"{RUN}.posted",
        run,
        f"Depreciation {start:%Y-%m}: {total}",
        {"journal": entry.number, "total": str(total), "assets": len(lines)},
    )
    publish_event(
        "assets.depreciation.posted",
        aggregate_type=RUN,
        aggregate_id=run.pk,
        company_id=run.company_id,
        payload={"period": start.isoformat(), "total": str(total)},
    )
    return run


@transaction.atomic
def reverse_run(
    ctx: ActorContext,
    run: DepreciationRun,
    *,
    reason: str,
    reversal_date: date | None = None,
    expected_version: int | None = None,
) -> DepreciationRun:
    """Reverse the journal and restore book values; the month can then be run again."""
    run = DepreciationRun.objects.select_for_update().get(pk=run.pk)
    workflow.check(run, expected_version, DepreciationRun.Status.POSTED)
    pdp.require(ctx, f"{RUN}.cancel", pdp.Resource.of(run))
    if not reason.strip():
        raise ValidationError({"reason": ["Give a reason for the reversal."]})
    if _live_runs(run.company_id).filter(period__gt=run.period).exists():
        raise BusinessRuleViolation("Reverse later depreciation runs first.", code="later_run_exists")
    entries = list(run.entries.order_by("asset_id"))
    assets = {a.pk: a for a in Asset.objects.select_for_update().filter(pk__in=[e.asset_id for e in entries])}
    disposed = [a.code for a in assets.values() if a.status == Asset.Status.DISPOSED]
    if disposed:
        raise BusinessRuleViolation(f"Assets already disposed: {', '.join(sorted(disposed))}.", code="asset_disposed")
    reversal = reverse_journal(
        ctx, run.journal_entry, reversal_date=reversal_date or month_bounds(run.period)[1], reason=reason
    )
    for e in entries:
        asset = assets[e.asset_id]
        asset.accumulated_depreciation -= e.amount
        asset.book_value = asset.cost - asset.accumulated_depreciation
        asset.version += 1
        asset.save(update_fields=["accumulated_depreciation", "book_value", "version", "updated_at"])
    workflow.bump(
        run,
        ctx,
        status=DepreciationRun.Status.REVERSED,
        reversal_journal=reversal,
        reversed_by=ctx.user,
        reversed_at=timezone.now(),
        reversal_reason=reason[:300],
    )
    _audit(ctx, f"{RUN}.reversed", run, reason, {"reversal_journal": reversal.number})
    return run


# --- Disposal -------------------------------------------------------------------------------------


def _gain_account(company_id, gain_account: Account | None) -> Account:
    """Gain on disposal: the account given, else the optional `other_income` determination key."""
    if gain_account is not None:
        return gain_account
    try:
        return resolve_account(company_id, "other_income")
    except BusinessRuleViolation as exc:
        raise BusinessRuleViolation(
            "Choose the income account for the gain on disposal (no 'other_income' posting rule is configured).",
            code="gain_account_required",
        ) from exc


@transaction.atomic
def dispose(
    ctx: ActorContext,
    asset: Asset,
    *,
    on: date,
    kind: str,
    proceeds: Decimal = ZERO,
    proceeds_account: Account | None = None,
    gain_account: Account | None = None,
    loss_account: Account | None = None,
    reason: str = "",
    expected_version: int | None = None,
) -> Asset:
    """Dr accumulated depreciation (to date), Dr bank (proceeds), Cr fixed assets (cost); the difference is a
    gain (Cr `gain_account`/`other_income`) or a loss (Dr `loss_account`/`expense_default`).

    Depreciation is taken as posted by runs up to the disposal; post the disposal month's run first if the
    month should be charged.
    """
    asset = _lock_asset(asset)
    workflow.check(asset, expected_version, Asset.Status.CAPITALIZED)
    pdp.require(ctx, f"{ASSET}.dispose", pdp.Resource.of(asset))
    proceeds = _money(proceeds or 0)
    if kind not in Asset.DisposalKind.values:
        raise ValidationError({"kind": ["Choose sale or scrap."]})
    if proceeds < 0 or (kind == Asset.DisposalKind.SALE and proceeds == 0):
        raise ValidationError({"proceeds": ["A sale needs positive proceeds; proceeds can't be negative."]})
    if on < asset.capitalization_date:
        raise ValidationError({"on": ["Disposal can't precede capitalization."]})
    for field, account in (
        ("proceeds_account", proceeds_account),
        ("gain_account", gain_account),
        ("loss_account", loss_account),
    ):
        _check_account(account, asset.company_id, field)
    # The disposal month may already be depreciated (charged in full); later months may not.
    if asset.depreciation_entries.filter(
        run__status=DepreciationRun.Status.POSTED, period__gt=on.replace(day=1)
    ).exists():
        raise BusinessRuleViolation(
            "Depreciation is posted after the disposal date. Reverse those runs first.",
            code="depreciation_after_disposal",
        )
    category, label = asset.category, f"{asset.code} {kind}"
    book_value = asset.cost - asset.accumulated_depreciation
    gain = proceeds - book_value
    lines = [
        _account_line(
            asset.accumulated_depreciation, category.accumulated_depreciation_account, "accumulated_depreciation", label
        ),
        _account_line(proceeds, proceeds_account, "default_bank", label),
        _account_line(-asset.cost, category.fixed_asset_account, "fixed_assets", label),
    ]
    if gain > 0:
        lines.append(
            Line(amount=-gain, account=_gain_account(asset.company_id, gain_account), description=f"{label}: gain")
        )
    elif gain < 0:
        lines.append(_account_line(-gain, loss_account, "expense_default", f"{label}: loss"))
    entry = post_journal(
        ctx,
        company_id=asset.company_id,
        entry_date=on,
        lines=lines,
        narration=f"Disposal ({kind}) of {asset.code} {asset.name}: {reason}"[:500],
        source_module=SOURCE_MODULE,
        source_type=ASSET,
        source_id=asset.pk,
    )
    workflow.bump(
        asset,
        ctx,
        status=Asset.Status.DISPOSED,
        disposal_kind=kind,
        disposal_date=on,
        disposal_proceeds=proceeds,
        disposal_gain=gain,
        disposal_journal=entry,
        book_value=ZERO,
    )
    _audit(
        ctx,
        f"{ASSET}.disposed",
        asset,
        reason or kind,
        {
            "kind": kind,
            "proceeds": str(proceeds),
            "book_value": str(book_value),
            "gain": str(gain),
            "journal": entry.number if entry else None,
        },
    )
    publish_event(
        "assets.asset.disposed",
        aggregate_type=ASSET,
        aggregate_id=asset.pk,
        company_id=asset.company_id,
        payload={"kind": kind, "gain": str(gain)},
    )
    return asset


# --- Meter readings -------------------------------------------------------------------------------


@transaction.atomic
def record_meter_reading(
    ctx: ActorContext, asset: Asset, *, reading: Decimal, reading_at: datetime | None = None, notes: str = ""
) -> MeterReading:
    asset = Asset.objects.select_for_update().get(pk=asset.pk)
    pdp.require(
        ctx, f"{METER}.create", pdp.Resource.ref(METER, company_id=asset.company_id, facility_id=asset.facility_id)
    )
    if asset.status == Asset.Status.DISPOSED:
        raise InvalidStateTransition("The asset is disposed.")
    reading, reading_at = Decimal(reading), reading_at or timezone.now()
    last = asset.meter_readings.order_by("-reading_at", "-created_at").first()
    if asset.current_meter_reading is not None and reading < asset.current_meter_reading:
        raise BusinessRuleViolation(
            f"Meter readings can't go down (last {asset.current_meter_reading.normalize()}).",
            code="meter_not_monotonic",
        )
    if last is not None and reading_at < last.reading_at:
        raise BusinessRuleViolation("A later reading is already recorded.", code="meter_not_monotonic")
    row = MeterReading.objects.create(
        company_id=asset.company_id,
        facility_id=asset.facility_id,
        asset=asset,
        reading=reading,
        reading_at=reading_at,
        recorded_by=ctx.user,
        notes=notes,
    )
    asset.current_meter_reading = reading
    asset.save(update_fields=["current_meter_reading", "updated_at"])
    return row


# --- Maintenance plans ----------------------------------------------------------------------------


def _validate_plan(plan: MaintenancePlan) -> None:
    if plan.trigger == MaintenancePlan.Trigger.CALENDAR:
        if not plan.interval_days or plan.next_due_date is None:
            raise ValidationError({"interval_days": ["A calendar plan needs an interval in days."]})
    elif plan.trigger == MaintenancePlan.Trigger.METER:
        if not plan.interval_meter or plan.interval_meter <= 0 or plan.next_due_meter is None:
            raise ValidationError({"interval_meter": ["A meter plan needs a positive meter interval."]})
    else:
        raise ValidationError({"trigger": ["Choose calendar or meter."]})
    if not isinstance(plan.checklist, list):
        raise ValidationError({"checklist": ["The checklist must be a list."]})


@transaction.atomic
def create_plan(
    ctx: ActorContext,
    *,
    asset: Asset,
    name: str,
    trigger: str,
    interval_days: int | None = None,
    interval_meter: Decimal | None = None,
    checklist: list | None = None,
    next_due_date: date | None = None,
    next_due_meter: Decimal | None = None,
    technician=None,
) -> MaintenancePlan:
    pdp.require(
        ctx, f"{PLAN}.create", pdp.Resource.ref(PLAN, company_id=asset.company_id, facility_id=asset.facility_id)
    )
    if asset.status == Asset.Status.DISPOSED:
        raise InvalidStateTransition("The asset is disposed.")
    if trigger == MaintenancePlan.Trigger.CALENDAR and next_due_date is None and interval_days:
        next_due_date = timezone.localdate() + timedelta(days=interval_days)
    if trigger == MaintenancePlan.Trigger.METER and next_due_meter is None and interval_meter:
        next_due_meter = (asset.current_meter_reading or ZERO) + Decimal(interval_meter)
    plan = MaintenancePlan(
        company_id=asset.company_id,
        facility_id=asset.facility_id,
        asset=asset,
        name=name,
        trigger=trigger,
        interval_days=interval_days,
        interval_meter=interval_meter,
        checklist=checklist or [],
        next_due_date=next_due_date,
        next_due_meter=next_due_meter,
        technician=technician,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    _validate_plan(plan)
    _check_user(technician, asset.company_id, "technician")
    plan.save()
    _audit(ctx, f"{PLAN}.created", plan, f"{asset.code}: {name}")
    return plan


PLAN_EDITABLE = (
    "name",
    "interval_days",
    "interval_meter",
    "checklist",
    "next_due_date",
    "next_due_meter",
    "technician",
    "is_active",
)


@transaction.atomic
def update_plan(ctx: ActorContext, plan: MaintenancePlan, data: dict, expected_version: int | None) -> MaintenancePlan:
    plan = MaintenancePlan.objects.select_for_update().get(pk=plan.pk)
    pdp.require(ctx, f"{PLAN}.update", pdp.Resource.of(plan))
    if expected_version is None or plan.version != expected_version:
        raise VersionConflict()
    unknown = set(data) - set(PLAN_EDITABLE)
    if unknown:
        raise ValidationError({f: ["This field can't be changed."] for f in sorted(unknown)})
    fields = PLAN_EDITABLE
    before = audit.snapshot(plan, fields)
    for key, value in data.items():
        setattr(plan, key, value)
    _validate_plan(plan)
    _check_user(plan.technician, plan.company_id, "technician")
    workflow.bump(plan, ctx)
    changes = audit.diff(before, audit.snapshot(plan, fields))
    if changes:
        _audit(ctx, f"{PLAN}.updated", plan, plan.name, changes)
    return plan


def _due_key(plan: MaintenancePlan, on_date: date) -> str | None:
    if plan.trigger == MaintenancePlan.Trigger.CALENDAR:
        return f"date:{plan.next_due_date.isoformat()}" if plan.next_due_date <= on_date else None
    current = plan.asset.current_meter_reading
    if current is not None and current >= plan.next_due_meter:
        return f"meter:{plan.next_due_meter.normalize():f}"
    return None


def _advance(plan: MaintenancePlan, on_date: date) -> None:
    """Move the next due point past `on_date` / the current reading (missed occurrences collapse into one WO)."""
    if plan.trigger == MaintenancePlan.Trigger.CALENDAR:
        steps = (on_date - plan.next_due_date).days // plan.interval_days + 1
        plan.next_due_date += timedelta(days=plan.interval_days * steps)
    else:
        steps = int((plan.asset.current_meter_reading - plan.next_due_meter) // plan.interval_meter) + 1
        plan.next_due_meter += plan.interval_meter * steps


def _new_work_order(
    ctx: ActorContext,
    *,
    asset: Asset,
    kind: str,
    reported_at: datetime,
    description: str = "",
    technician=None,
    plan: MaintenancePlan | None = None,
    due_key: str = "",
    checklist: list | None = None,
) -> MaintenanceWorkOrder:
    wo = MaintenanceWorkOrder.objects.create(
        company_id=asset.company_id,
        facility_id=asset.facility_id,
        asset=asset,
        kind=kind,
        plan=plan,
        due_key=due_key,
        description=description,
        checklist=checklist or [],
        reported_at=reported_at,
        technician=technician,
        created_by=ctx.user,
        updated_by=ctx.user,
        number=allocate_number(asset.company_id, "MWO", timezone.localdate(reported_at)),
    )
    _audit(ctx, f"{WO}.created", wo, f"{wo.number} {kind} {asset.code}")
    if technician is not None:
        notifications.notify(
            [technician],
            category="assets.work_order",
            title=f"Work order {wo.number}",
            body=f"{kind.capitalize()} maintenance on {asset.code} {asset.name}",
            link=f"/assets/work-orders/{wo.pk}",
            resource_type=WO,
            resource_id=wo.pk,
            company_id=asset.company_id,
            dedupe_key=f"wo-assigned:{wo.pk}:{technician.pk}",
        )
    return wo


@transaction.atomic
def generate_due_work_orders(ctx: ActorContext, on_date: date, company_id=None) -> list[MaintenanceWorkOrder]:
    """Create preventive work orders for every due plan and advance its next due point.

    Idempotent: a plan occurrence (`due_key`) yields at most one work order (DB unique constraint), and the
    plan's next due point moves past `on_date`, so re-running the same day creates nothing.
    """
    plans = MaintenancePlan.objects.filter(is_active=True, asset__status=Asset.Status.CAPITALIZED)
    if company_id is not None:
        plans = plans.filter(company_id=company_id)
    if not ctx.is_system:
        plans = pdp.filter_queryset(ctx, f"{WO}.create", plans)
    created = []
    for plan_id in plans.order_by("pk").values_list("pk", flat=True):
        plan = (
            MaintenancePlan.objects.select_for_update(of=("self",))
            .select_related("asset", "technician")
            .get(pk=plan_id)
        )
        key = _due_key(plan, on_date)
        if key is None:
            continue
        if ctx.is_system and not flags.is_enabled(flags.module_flag_key("assets"), company_id=plan.company_id):
            continue  # module switched off for this company
        pdp.require(ctx, f"{WO}.create", pdp.Resource.ref(WO, company_id=plan.company_id, facility_id=plan.facility_id))
        if not MaintenanceWorkOrder.objects.filter(plan=plan, due_key=key).exists():
            created.append(
                _new_work_order(
                    ctx,
                    asset=plan.asset,
                    kind=MaintenanceWorkOrder.Kind.PREVENTIVE,
                    reported_at=timezone.now(),
                    description=plan.name,
                    technician=plan.technician,
                    plan=plan,
                    due_key=key,
                    checklist=plan.checklist,
                )
            )
        _advance(plan, on_date)
        plan.last_generated_at = timezone.now()
        plan.version += 1
        plan.save(update_fields=["next_due_date", "next_due_meter", "last_generated_at", "version", "updated_at"])
    return created


# --- Work orders ----------------------------------------------------------------------------------


@transaction.atomic
def create_work_order(
    ctx: ActorContext,
    *,
    asset: Asset,
    kind: str,
    description: str = "",
    reported_at: datetime | None = None,
    technician=None,
) -> MaintenanceWorkOrder:
    pdp.require(ctx, f"{WO}.create", pdp.Resource.ref(WO, company_id=asset.company_id, facility_id=asset.facility_id))
    if asset.status == Asset.Status.DISPOSED:
        raise InvalidStateTransition("The asset is disposed.")
    if kind not in MaintenanceWorkOrder.Kind.values:
        raise ValidationError({"kind": ["Choose preventive or breakdown."]})
    _check_user(technician, asset.company_id, "technician")
    return _new_work_order(
        ctx,
        asset=asset,
        kind=kind,
        reported_at=reported_at or timezone.now(),
        description=description,
        technician=technician,
    )


def _lock_wo(wo: MaintenanceWorkOrder) -> MaintenanceWorkOrder:
    return MaintenanceWorkOrder.objects.select_for_update(of=("self",)).select_related("asset").get(pk=wo.pk)


@transaction.atomic
def start_work_order(
    ctx: ActorContext,
    wo: MaintenanceWorkOrder,
    *,
    started_at: datetime | None = None,
    technician=None,
    expected_version: int | None = None,
) -> MaintenanceWorkOrder:
    wo = _lock_wo(wo)
    workflow.check(wo, expected_version, MaintenanceWorkOrder.Status.OPEN)
    pdp.require(ctx, f"{WO}.update", pdp.Resource.of(wo))
    _check_user(technician, wo.company_id, "technician")
    started_at = started_at or timezone.now()
    if started_at < wo.reported_at:
        raise ValidationError({"started_at": ["Work can't start before it is reported."]})
    workflow.bump(
        wo,
        ctx,
        status=MaintenanceWorkOrder.Status.IN_PROGRESS,
        started_at=started_at,
        technician=technician or wo.technician or ctx.user,
    )
    _audit(ctx, f"{WO}.started", wo, wo.number)
    return wo


@transaction.atomic
def issue_spares(
    ctx: ActorContext, wo: MaintenanceWorkOrder, *, lines: list[dict], on: date, expected_version: int | None = None
) -> MaintenanceWorkOrder:
    """Issue spares from stores to the work order: Cr inventory, Dr `maintenance_expense` (inventory engine)."""
    wo = _lock_wo(wo)
    workflow.check(wo, expected_version, MaintenanceWorkOrder.Status.OPEN, MaintenanceWorkOrder.Status.IN_PROGRESS)
    pdp.require(ctx, f"{WO}.update", pdp.Resource.of(wo))
    if not lines:
        raise ValidationError({"lines": ["Add at least one spare."]})
    moves = []
    for line in lines:
        item, warehouse, qty = line["item"], line["warehouse"], Decimal(line["quantity"])
        if qty <= 0:
            raise ValidationError({"lines": ["Quantities must be positive."]})
        if warehouse.company_id != wo.company_id:
            raise ValidationError({"lines": [f"Warehouse {warehouse.code} belongs to another company."]})
        batch = get_or_create_batch(wo.company_id, item, line.get("batch_number", ""), create=False)
        moves.append(
            Move(
                item=item,
                warehouse=warehouse,
                quantity=-qty,
                movement_type="maintenance_issue",
                batch=batch,
                serials=line.get("serials", []),
                contra_key="maintenance_expense",
            )
        )
    txn = post_stock(
        ctx,
        company_id=wo.company_id,
        posting_date=on,
        moves=moves,
        source_type=WO,
        source_id=wo.pk,
        reference=wo.number,
        narration=f"Spares issued to {wo.number} ({wo.asset.code})",
    )
    WorkOrderSpare.objects.bulk_create(
        [
            WorkOrderSpare(
                work_order=wo,
                item=m.item,
                warehouse=m.warehouse,
                quantity=-m.quantity,
                value=-m.value,
                stock_transaction=txn,
                issued_on=on,
                issued_by=ctx.user,
            )
            for m in moves
        ]
    )
    total = sum((-m.value for m in moves), ZERO)
    changes = {"spare_cost": wo.spare_cost + total}
    if wo.status == MaintenanceWorkOrder.Status.OPEN:
        changes.update(status=MaintenanceWorkOrder.Status.IN_PROGRESS, started_at=wo.started_at or timezone.now())
    workflow.bump(wo, ctx, **changes)
    _audit(ctx, f"{WO}.spares_issued", wo, f"{wo.number}: {total}", {"lines": len(moves), "value": str(total)})
    return wo


@transaction.atomic
def complete_work_order(
    ctx: ActorContext,
    wo: MaintenanceWorkOrder,
    *,
    completed_at: datetime | None = None,
    downtime_minutes: int | None = None,
    labour_hours: Decimal | None = None,
    notes: str = "",
    checklist: list | None = None,
    expected_version: int | None = None,
) -> MaintenanceWorkOrder:
    """Downtime defaults to reported -> completed for breakdowns and started -> completed for preventive work."""
    wo = _lock_wo(wo)
    workflow.check(wo, expected_version, MaintenanceWorkOrder.Status.OPEN, MaintenanceWorkOrder.Status.IN_PROGRESS)
    pdp.require(ctx, f"{WO}.update", pdp.Resource.of(wo))
    completed_at = completed_at or timezone.now()
    started_at = wo.started_at or wo.reported_at
    if completed_at < started_at:
        raise ValidationError({"completed_at": ["Completion can't precede the start of work."]})
    if downtime_minutes is None:
        since = wo.reported_at if wo.kind == MaintenanceWorkOrder.Kind.BREAKDOWN else started_at
        downtime_minutes = int((completed_at - since).total_seconds() // 60)
    if checklist is not None and not isinstance(checklist, list):
        raise ValidationError({"checklist": ["The checklist must be a list."]})
    workflow.bump(
        wo,
        ctx,
        status=MaintenanceWorkOrder.Status.COMPLETED,
        started_at=started_at,
        completed_at=completed_at,
        downtime_minutes=downtime_minutes,
        labour_hours=wo.labour_hours if labour_hours is None else Decimal(labour_hours),
        notes=notes or wo.notes,
        checklist=wo.checklist if checklist is None else checklist,
    )
    _audit(
        ctx,
        f"{WO}.completed",
        wo,
        wo.number,
        {"downtime_minutes": downtime_minutes, "labour_hours": str(wo.labour_hours)},
    )
    publish_event(
        "assets.work_order.completed",
        aggregate_type=WO,
        aggregate_id=wo.pk,
        company_id=wo.company_id,
        payload={"asset": str(wo.asset_id), "kind": wo.kind, "downtime_minutes": downtime_minutes},
    )
    return wo


@transaction.atomic
def close_work_order(
    ctx: ActorContext, wo: MaintenanceWorkOrder, expected_version: int | None = None
) -> MaintenanceWorkOrder:
    wo = _lock_wo(wo)
    workflow.check(wo, expected_version, MaintenanceWorkOrder.Status.COMPLETED)
    pdp.require(ctx, f"{WO}.close", pdp.Resource.of(wo))
    workflow.bump(wo, ctx, status=MaintenanceWorkOrder.Status.CLOSED, closed_at=timezone.now())
    _audit(ctx, f"{WO}.closed", wo, wo.number, {"spare_cost": str(wo.spare_cost)})
    return wo


@transaction.atomic
def cancel_work_order(
    ctx: ActorContext, wo: MaintenanceWorkOrder, *, reason: str, expected_version: int | None = None
) -> MaintenanceWorkOrder:
    wo = _lock_wo(wo)
    workflow.check(wo, expected_version, MaintenanceWorkOrder.Status.OPEN)
    pdp.require(ctx, f"{WO}.close", pdp.Resource.of(wo))
    if wo.spares.exists():
        raise BusinessRuleViolation(
            "Spares were issued to this work order; complete and close it instead.", code="work_order_has_spares"
        )
    workflow.bump(wo, ctx, status=MaintenanceWorkOrder.Status.CANCELLED, closed_at=timezone.now())
    _audit(ctx, f"{WO}.cancelled", wo, reason)
    return wo


# --- Reliability (MTBF / MTTR) --------------------------------------------------------------------


def reliability(asset: Asset, *, start: datetime | None = None, end: datetime | None = None) -> dict:
    """MTBF and MTTR from completed breakdown work orders reported within the window.

    Window defaults to [put-to-use date (or creation), now]. MTTR = downtime / failures;
    MTBF = (window - downtime) / failures. Hours, rounded to 0.01; None when there were no failures.
    """
    tz = timezone.get_current_timezone()
    if start is None:
        start = (
            datetime.combine(asset.put_to_use_date, datetime.min.time(), tzinfo=tz)
            if asset.put_to_use_date
            else asset.created_at
        )
    end = end or timezone.now()
    if end <= start:
        raise ValidationError({"end": ["The window end must be after its start."]})
    failures = MaintenanceWorkOrder.objects.filter(
        asset=asset,
        kind=MaintenanceWorkOrder.Kind.BREAKDOWN,
        reported_at__gte=start,
        reported_at__lt=end,
        status__in=[MaintenanceWorkOrder.Status.COMPLETED, MaintenanceWorkOrder.Status.CLOSED],
    )
    agg = failures.aggregate(downtime=Sum("downtime_minutes"))
    count = failures.count()
    downtime = Decimal(agg["downtime"] or 0)
    window = Decimal(int((end - start).total_seconds() // 60))
    uptime = max(window - downtime, ZERO)

    def hours(minutes: Decimal) -> Decimal:
        return _money(minutes / MINUTES_PER_HOUR)

    return {
        "asset": str(asset.pk),
        "asset_code": asset.code,
        "window_start": start,
        "window_end": end,
        "failures": count,
        "downtime_hours": hours(downtime),
        "operating_hours": hours(uptime),
        "mtbf_hours": hours(uptime / count) if count else None,
        "mttr_hours": hours(downtime / count) if count else None,
        "availability_pct": _money(uptime / window * HUNDRED) if window else None,
    }
