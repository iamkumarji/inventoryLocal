from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.db import DatabaseError, IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.assets import services
from apps.assets.models import (
    Asset,
    AssetCategory,
    DepreciationEntry,
    DepreciationRun,
    MaintenancePlan,
    MaintenanceWorkOrder,
)
from apps.authorization.models import ApprovalLimit
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition, VersionConflict
from apps.core.ids import uuid7
from apps.core.models import FeatureFlag
from apps.finance.models import Account, AccountDetermination, JournalEntry
from apps.inventory import selectors
from apps.inventory.engine import Move, post_stock
from conftest import gl_balance

pytestmark = [pytest.mark.django_db, pytest.mark.req("AST-001")]
D = Decimal
TODAY = timezone.localdate
ASSET_PERMS = ["assets.asset." + a for a in ("create", "read", "update")] + [
    "assets.asset_category." + a for a in ("create", "read", "update")
]
MAINT_PERMS = (
    ["assets.work_order." + a for a in ("create", "read", "update", "close")]
    + ["assets.maintenance_plan." + a for a in ("create", "read", "update")]
    + ["assets.meter_reading." + a for a in ("create", "read")]
    + ["assets.asset.read"]
)


@pytest.fixture(autouse=True)
def modules(db):
    for key in ("module.assets", "module.inventory"):
        FeatureFlag.objects.create(key=key, enabled_default=True)


@pytest.fixture
def fy(fiscal_year):
    return fiscal_year.start_date


def month(fy_start: date, offset: int, day: int = 1) -> date:
    y, m = divmod(fy_start.month - 1 + offset, 12)
    return date(fy_start.year + y, m + 1, day)


@pytest.fixture
def team(org, books, plant, make_user, make_role, grant):
    clerk, approver, director, accountant, technician = (
        make_user(full_name=n) for n in ("Clerk", "Approver", "Director", "Accountant", "Technician")
    )
    grant(clerk, ASSET_PERMS, books)
    for user, limit in ((approver, D("1000000")), (director, D("5000000"))):
        role = make_role(["assets.asset.approve", "assets.asset.reject", "assets.asset.read"])
        grant(user, [], books, role=role)
        ApprovalLimit.objects.create(
            organization=org, role=role, document_type="assets.asset", currency="INR", max_amount=limit
        )
    grant(
        accountant,
        ["assets.depreciation_run." + a for a in ("create", "read", "post", "cancel")]
        + ["assets.asset.dispose", "assets.asset.read"],
        books,
    )
    grant(technician, MAINT_PERMS, plant["facility"])
    return {
        "clerk": clerk,
        "approver": approver,
        "director": director,
        "accountant": accountant,
        "technician": technician,
    }


@pytest.fixture
def categories(books):
    slm = AssetCategory.objects.create(
        company=books,
        code="PM",
        name="Plant and machinery",
        depreciation_method="slm",
        useful_life_months=60,
        salvage_pct=D("5"),
    )
    wdv = AssetCategory.objects.create(
        company=books, code="VEH", name="Vehicles", depreciation_method="wdv", wdv_rate=D("20"), salvage_pct=D("5")
    )
    return {"slm": slm, "wdv": wdv}


@pytest.fixture
def new_asset(team, books, plant, categories, ctx, fy):
    seq = iter(range(1, 1000))

    def _make(category="slm", cost="600000", put_to_use=None, **kw):
        return services.create_asset(
            ctx(team["clerk"]),
            company=books,
            facility=plant["facility"],
            category=categories[category],
            code=kw.pop("code", f"FA-{next(seq):03d}"),
            name=kw.pop("name", "CNC lathe"),
            acquisition_date=kw.pop("acquisition_date", fy),
            cost=D(cost),
            put_to_use_date=put_to_use or fy,
            **kw,
        )

    return _make


@pytest.fixture
def capitalized(new_asset, team, ctx):
    def _make(*args, **kw):
        return services.capitalize(ctx(team["approver"]), new_asset(*args, **kw))

    return _make


def run_month(ctx, user, books, period):
    run = services.create_run(ctx(user), company=books, period=period)
    return services.post_run(ctx(user), run)


@pytest.mark.req("AST-002")
def test_capitalization_posts_journal_and_routes_above_limit(new_asset, team, ctx, books):
    asset = new_asset(cost="600000")
    assert asset.salvage_value == D("30000.00")  # 5% from the category
    with pytest.raises(AuthorizationDenied):  # the maker can't capitalize their own asset
        services.capitalize(ctx(team["clerk"]), asset)
    asset = services.capitalize(ctx(team["approver"]), asset)
    assert (asset.status, asset.book_value) == ("capitalized", D("600000"))
    assert gl_balance(books, "1500") == D("600000") and gl_balance(books, "1110") == D("-600000")

    # Above the approver's limit: direct capitalization is refused; the workflow decides.
    big = new_asset(cost="2000000", name="Press line")
    with pytest.raises(BusinessRuleViolation) as exc:
        services.capitalize(ctx(team["approver"]), big)
    assert exc.value.code == "approval_limit_exceeded"
    big = services.submit_for_capitalization(ctx(team["clerk"]), big)
    assert big.status == "submitted"
    with pytest.raises(AuthorizationDenied):
        services.decide_capitalization(ctx(team["approver"]), big, approve=True)
    big = services.decide_capitalization(ctx(team["director"]), big, approve=True)
    assert big.status == "capitalized" and big.approved_by == team["director"]
    assert gl_balance(books, "1500") == D("2600000")

    # Capitalization against a supplied contra account (e.g. goods received not invoiced).
    grni = Account.objects.get(company=books, code="2150")
    services.capitalize(ctx(team["approver"]), new_asset(cost="50000", contra_account=grni))
    assert gl_balance(books, "2150") == D("-50000") and gl_balance(books, "1110") == D("-2600000")


def test_capitalization_through_approval_route(new_asset, team, ctx, books, org):
    """With an approval matrix for assets.asset, the route's final approval posts the capitalization."""
    from apps.approvals import services as approvals
    from apps.approvals.models import ApprovalLevel, ApprovalMatrix, ApprovalRequest
    from apps.authorization.models import RoleAssignment

    matrix = ApprovalMatrix.objects.create(organization=org, document_type="assets.asset", name="Capex")
    ApprovalLevel.objects.create(
        matrix=matrix, sequence=1, name="Director", role=RoleAssignment.objects.get(user=team["director"]).role
    )
    big = services.submit_for_capitalization(ctx(team["clerk"]), new_asset(cost="2000000"))
    request = ApprovalRequest.objects.get(document_type="assets.asset", document_id=big.pk)
    with pytest.raises(BusinessRuleViolation) as exc:
        services.decide_capitalization(ctx(team["director"]), big, approve=True)
    assert exc.value.code == "approval_route_active"
    approvals.decide(ctx(team["director"]), request, approve=True, comment="Budgeted capex")
    big.refresh_from_db()
    assert big.status == "capitalized" and big.capitalization_journal_id is not None
    assert gl_balance(books, "1500") == D("2000000")


def test_asset_update_uses_optimistic_locking_and_freezes_book_fields(new_asset, team, ctx):
    asset = new_asset()
    with pytest.raises(VersionConflict):
        services.update_asset(ctx(team["clerk"]), asset, {"name": "Lathe"}, asset.version + 1)
    asset = services.update_asset(ctx(team["clerk"]), asset, {"cost": D("610000")}, asset.version)
    assert asset.book_value == D("610000")
    asset = services.capitalize(ctx(team["approver"]), asset)
    with pytest.raises(ValidationError, match="can't be changed"):
        services.update_asset(ctx(team["clerk"]), asset, {"cost": D("1")}, asset.version)
    asset = services.update_asset(ctx(team["clerk"]), asset, {"location": "Bay 4"}, asset.version)
    assert asset.location == "Bay 4"


@pytest.mark.req("AST-003")
def test_slm_and_wdv_monthly_depreciation_with_pro_rata(capitalized, team, ctx, books, fy):
    lathe = capitalized("slm", "600000", put_to_use=month(fy, 0, 16))  # (600000-30000)/60 = 9500/month
    truck = capitalized("wdv", "120000", put_to_use=month(fy, 0, 1))  # 20% p.a. on opening WDV
    acct = team["accountant"]
    run = services.create_run(ctx(acct), company=books, period=month(fy, 0, 20))
    assert run.period == month(fy, 0)
    preview = {ln.asset.code: ln.amount for ln in services.compute_run(run)}
    assert preview == {lathe.code: D("4750.00"), truck.code: D("2000.00")}  # lathe: 15 of 30 days
    run = services.post_run(ctx(acct), run)
    assert (run.status, run.total_amount, run.asset_count) == ("posted", D("6750"), 2)
    journal = JournalEntry.objects.get(pk=run.journal_entry_id)
    assert journal.lines.count() == 4  # one expense/accumulated pair per asset
    assert set(journal.lines.values_list("description", flat=True)) == {
        f"{lathe.code} depreciation {month(fy, 0):%Y-%m}",
        f"{truck.code} depreciation {month(fy, 0):%Y-%m}",
    }
    assert gl_balance(books, "5500") == D("6750") and gl_balance(books, "1510") == D("-6750")

    run_month(ctx, acct, books, month(fy, 1))
    lathe.refresh_from_db()
    truck.refresh_from_db()
    assert lathe.accumulated_depreciation == D("14250")  # 4750 + 9500
    assert truck.accumulated_depreciation == D("3966.67")  # 2000 + 118000 x 20% / 12
    entry = DepreciationEntry.objects.get(asset=truck, period=month(fy, 1))
    assert (entry.opening_book_value, entry.amount, entry.book_value_after) == (
        D("118000"),
        D("1966.67"),
        D("116033.33"),
    )
    assert truck.book_value == D("116033.33")
    with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
        DepreciationEntry.objects.filter(pk=entry.pk).update(amount=D("1"))


def test_depreciation_never_goes_below_salvage(capitalized, team, ctx, books, fy):
    tool = capitalized(
        "slm", "10000", put_to_use=month(fy, 0, 16), salvage_value=D("1000"), useful_life_months=3
    )  # 3000/month
    amounts = []
    for offset in range(4):
        run_month(ctx, team["accountant"], books, month(fy, offset))
        amounts.append(DepreciationEntry.objects.get(asset=tool, period=month(fy, offset)).amount)
    assert amounts == [D("1500"), D("3000"), D("3000"), D("1500")]  # last month capped at salvage
    tool.refresh_from_db()
    assert tool.book_value == tool.salvage_value == D("1000")
    run = services.create_run(ctx(team["accountant"]), company=books, period=month(fy, 4))
    with pytest.raises(BusinessRuleViolation) as exc:
        services.post_run(ctx(team["accountant"]), run)
    assert exc.value.code == "nothing_to_depreciate"


def test_assets_not_yet_in_use_or_disposed_are_skipped(capitalized, new_asset, team, ctx, books, fy):
    in_use = capitalized("slm", "600000", put_to_use=month(fy, 0, 1))
    capitalized("slm", "600000", put_to_use=month(fy, 1, 1))  # in use only from next month
    new_asset(put_to_use=month(fy, 0, 1))  # never capitalized
    run = run_month(ctx, team["accountant"], books, month(fy, 0))
    assert list(run.entries.values_list("asset__code", flat=True)) == [in_use.code]


@pytest.mark.req("AST-004")
def test_duplicate_run_is_prevented(capitalized, team, ctx, books, fy):
    capitalized()
    run_month(ctx, team["accountant"], books, month(fy, 0))
    with pytest.raises(BusinessRuleViolation) as exc:
        services.create_run(ctx(team["accountant"]), company=books, period=month(fy, 0, 15))
    assert exc.value.code == "depreciation_run_exists"
    with pytest.raises(IntegrityError), transaction.atomic():
        DepreciationRun.objects.create(company=books, period=month(fy, 0))
    with pytest.raises(InvalidStateTransition):  # posted runs can't be posted twice either
        services.post_run(ctx(team["accountant"]), DepreciationRun.objects.get(company=books))


def test_posting_requires_mfa(capitalized, team, ctx, books, fy):
    capitalized()
    run = services.create_run(ctx(team["accountant"]), company=books, period=month(fy, 0))
    with pytest.raises(AuthorizationDenied) as exc:
        services.post_run(ctx(team["accountant"], mfa=False), run)
    assert exc.value.reason == "mfa_required"


def test_period_lock_is_respected(capitalized, team, ctx, books, fy):
    from apps.organization.services import period_for

    capitalized()
    run = services.create_run(ctx(team["accountant"]), company=books, period=month(fy, 0))
    period = period_for(books.pk, month(fy, 0))
    period.gl_locked = True
    period.save(update_fields=["gl_locked"])
    with pytest.raises(BusinessRuleViolation) as exc:
        services.post_run(ctx(team["accountant"]), run)
    assert exc.value.code == "period_locked"
    run.refresh_from_db()
    assert run.status == "draft" and not DepreciationEntry.objects.exists()


@pytest.mark.req("AST-005")
def test_reversal_then_rerun(capitalized, team, ctx, books, fy):
    lathe = capitalized("slm", "600000", put_to_use=month(fy, 0, 16))
    acct = team["accountant"]
    april = run_month(ctx, acct, books, month(fy, 0))
    may = run_month(ctx, acct, books, month(fy, 1))
    with pytest.raises(BusinessRuleViolation) as exc:
        services.reverse_run(ctx(acct), april, reason="Wrong life")
    assert exc.value.code == "later_run_exists"
    may = services.reverse_run(ctx(acct), may, reason="Correction")
    assert may.status == "reversed"
    lathe.refresh_from_db()
    assert lathe.accumulated_depreciation == D("4750")
    assert gl_balance(books, "5500") == D("4750") and gl_balance(books, "1510") == D("-4750")
    rerun = run_month(ctx, acct, books, month(fy, 1))  # the month is free again
    assert rerun.total_amount == D("9500") and rerun.pk != may.pk
    assert gl_balance(books, "5500") == D("14250")
    assert JournalEntry.objects.get(pk=may.journal_entry_id).reversed_by_id == may.reversal_journal_id


@pytest.mark.req("AST-006")
def test_disposal_by_sale_with_gain(capitalized, team, ctx, books, fy):
    lathe = capitalized("slm", "600000", put_to_use=month(fy, 0, 16))
    run_month(ctx, team["accountant"], books, month(fy, 0))  # accumulated 4750, book value 595250
    rule = AccountDetermination.objects.get(company=books, key="other_income")
    rule.is_active = False
    rule.save()
    with pytest.raises(BusinessRuleViolation) as exc:  # no `other_income` rule and no account given
        services.dispose(ctx(team["accountant"]), lathe, on=month(fy, 1, 10), kind="sale", proceeds=D("600000"))
    assert exc.value.code == "gain_account_required"
    rule.is_active = True
    rule.save()
    lathe = services.dispose(
        ctx(team["accountant"]), lathe, on=month(fy, 1, 10), kind="sale", proceeds=D("600000"), reason="Sold to dealer"
    )  # gain to the template's other_income rule (4200)
    assert (lathe.status, lathe.disposal_gain, lathe.book_value) == ("disposed", D("4750"), D("0"))
    assert gl_balance(books, "1500") == D("0") and gl_balance(books, "1510") == D("0")
    assert gl_balance(books, "4200") == D("-4750")
    assert gl_balance(books, "1110") == D("0")  # paid 600000, received 600000
    run = services.create_run(ctx(team["accountant"]), company=books, period=month(fy, 1))
    assert services.compute_run(run) == []  # disposed assets aren't depreciated


def test_disposal_by_scrap_with_loss(capitalized, team, ctx, books, fy):
    lathe = capitalized("slm", "600000", put_to_use=month(fy, 0, 16))
    acct = team["accountant"]
    run_month(ctx, acct, books, month(fy, 0))
    may = run_month(ctx, acct, books, month(fy, 1))
    with pytest.raises(BusinessRuleViolation) as exc:  # May is already depreciated: reverse it first
        services.dispose(ctx(acct), lathe, on=month(fy, 0, 25), kind="scrap")
    assert exc.value.code == "depreciation_after_disposal"
    services.reverse_run(ctx(acct), may, reason="Asset scrapped in April")
    lathe = services.dispose(ctx(acct), lathe, on=month(fy, 0, 25), kind="scrap", proceeds=D("10000"))
    assert lathe.disposal_gain == D("-585250")  # 10000 - (600000 - 4750)
    assert gl_balance(books, "5430") == D("585250")  # expense_default
    assert gl_balance(books, "1500") == D("0") and gl_balance(books, "1510") == D("0")
    assert gl_balance(books, "1110") == D("-590000")


@pytest.fixture
def spares(make_item, books, plant, system_ctx):
    bearing = make_item("BEARING-6205", group="SPARE", uom="nos", item_type="spare")
    with transaction.atomic():
        post_stock(
            system_ctx,
            company_id=books.pk,
            posting_date=TODAY(),
            source_type="test.opening",
            source_id=uuid7(),
            moves=[
                Move(
                    item=bearing,
                    warehouse=plant["rm"],
                    quantity=D("10"),
                    movement_type="opening",
                    unit_cost=D("250"),
                    contra_key="inventory_adjustment",
                )
            ],
        )
    return {"bearing": bearing}


@pytest.mark.req("AST-007")
def test_preventive_work_orders_generated_idempotently(capitalized, team, ctx, books):
    tech = ctx(team["technician"])
    asset = capitalized()
    due = TODAY() - timedelta(days=1)
    calendar_plan = services.create_plan(
        tech,
        asset=asset,
        name="Monthly lubrication",
        trigger="calendar",
        interval_days=30,
        next_due_date=due,
        checklist=["Grease spindle"],
        technician=team["technician"],
    )
    meter_plan = services.create_plan(tech, asset=asset, name="Oil change", trigger="meter", interval_meter=D("500"))
    assert meter_plan.next_due_meter == D("500")
    created = services.generate_due_work_orders(tech, TODAY())
    assert [wo.plan_id for wo in created] == [calendar_plan.pk]
    wo = created[0]
    assert (wo.kind, wo.status, wo.checklist, wo.due_key) == (
        "preventive",
        "open",
        ["Grease spindle"],
        f"date:{due.isoformat()}",
    )
    assert services.generate_due_work_orders(tech, TODAY()) == []  # idempotent
    calendar_plan.refresh_from_db()
    assert calendar_plan.next_due_date == due + timedelta(days=30)

    services.record_meter_reading(tech, asset, reading=D("520"))
    with pytest.raises(BusinessRuleViolation) as exc:
        services.record_meter_reading(tech, asset, reading=D("510"))
    assert exc.value.code == "meter_not_monotonic"
    created = services.generate_due_work_orders(ctx(team["technician"]), TODAY())
    assert [wo.due_key for wo in created] == ["meter:500"]
    assert services.generate_due_work_orders(tech, TODAY()) == []
    meter_plan.refresh_from_db()
    assert meter_plan.next_due_meter == D("1000")
    assert MaintenanceWorkOrder.objects.filter(kind="preventive").count() == 2
    # The scheduled task path (system actor) is idempotent too.
    from apps.core.context import ActorContext

    assert services.generate_due_work_orders(ActorContext.system("tests"), TODAY()) == []


@pytest.mark.req("AST-008")
def test_breakdown_work_order_issues_spares_and_expenses_them(capitalized, spares, team, ctx, books, plant):
    tech = ctx(team["technician"])
    asset = capitalized()
    reported = timezone.now() - timedelta(hours=3)
    wo = services.create_work_order(
        tech, asset=asset, kind="breakdown", description="Spindle seized", reported_at=reported
    )
    wo = services.start_work_order(tech, wo, started_at=reported + timedelta(minutes=30))
    wo = services.issue_spares(
        tech, wo, lines=[{"item": spares["bearing"], "warehouse": plant["rm"], "quantity": D("4")}], on=TODAY()
    )
    assert wo.spare_cost == D("1000")
    stock = selectors.availability(books.pk, spares["bearing"].pk, plant["rm"].pk)
    assert (stock["on_hand"], stock["value"]) == (D("6"), D("1500"))
    assert gl_balance(books, "5420") == D("1000") and gl_balance(books, "1330") == D("1500")
    wo = services.complete_work_order(tech, wo, completed_at=reported + timedelta(hours=2), labour_hours=D("1.5"))
    assert (wo.status, wo.downtime_minutes) == ("completed", 120)  # reported -> completed
    with pytest.raises(InvalidStateTransition):
        services.issue_spares(
            tech, wo, lines=[{"item": spares["bearing"], "warehouse": plant["rm"], "quantity": D("1")}], on=TODAY()
        )
    wo = services.close_work_order(tech, wo)
    assert wo.status == "closed" and wo.spares.count() == 1


def test_insufficient_spares_are_blocked(capitalized, spares, team, ctx, books, plant):
    tech = ctx(team["technician"])
    wo = services.create_work_order(tech, asset=capitalized(), kind="breakdown", description="Belt snapped")
    with pytest.raises(BusinessRuleViolation) as exc:
        services.issue_spares(
            tech, wo, lines=[{"item": spares["bearing"], "warehouse": plant["rm"], "quantity": D("20")}], on=TODAY()
        )
    assert exc.value.code == "insufficient_stock"
    assert selectors.availability(books.pk, spares["bearing"].pk, plant["rm"].pk)["on_hand"] == D("10")
    assert gl_balance(books, "5420") == D("0")
    wo.refresh_from_db()
    assert (wo.status, wo.spare_cost) == ("open", D("0"))


@pytest.mark.req("AST-009")
def test_mtbf_and_mttr_from_breakdowns(capitalized, team, ctx):
    tech = ctx(team["technician"])
    asset = capitalized()
    t0 = timezone.now() - timedelta(hours=2000)
    for start_h, repair_h in ((100, 2), (500, 6)):
        wo = services.create_work_order(tech, asset=asset, kind="breakdown", reported_at=t0 + timedelta(hours=start_h))
        services.complete_work_order(tech, wo, completed_at=t0 + timedelta(hours=start_h + repair_h))
    services.create_work_order(tech, asset=asset, kind="breakdown", reported_at=t0 + timedelta(hours=700))  # open
    pm = services.create_work_order(tech, asset=asset, kind="preventive", reported_at=t0 + timedelta(hours=800))
    services.complete_work_order(tech, pm, completed_at=t0 + timedelta(hours=810))
    report = services.reliability(asset, start=t0, end=t0 + timedelta(hours=1000))
    assert report["failures"] == 2
    assert report["downtime_hours"] == D("8.00")
    assert report["mttr_hours"] == D("4.00")
    assert report["mtbf_hours"] == D("496.00")  # (1000 - 8) / 2
    assert report["availability_pct"] == D("99.20")
    empty = services.reliability(asset, start=t0 + timedelta(hours=1500), end=t0 + timedelta(hours=1600))
    assert (empty["failures"], empty["mtbf_hours"], empty["mttr_hours"]) == (0, None, None)


def test_work_order_scope_is_enforced(capitalized, team, ctx, make_user, grant, make_facility, make_branch, books):
    asset = capitalized()
    other_site = make_facility(make_branch(books))
    outsider = make_user()
    grant(outsider, MAINT_PERMS, other_site)
    with pytest.raises(AuthorizationDenied):
        services.create_work_order(ctx(outsider), asset=asset, kind="breakdown")
    with pytest.raises(AuthorizationDenied):
        services.record_meter_reading(ctx(outsider), asset, reading=D("1"))


# --- API ------------------------------------------------------------------------------------------


def test_api_asset_lifecycle(api_for, team, categories, books, plant, fy, spares):
    clerk, approver, acct, tech = (api_for(team[k]) for k in ("clerk", "approver", "accountant", "technician"))
    r = clerk.post(
        "/api/v1/assets/assets/",
        {
            "company": str(books.pk),
            "facility": str(plant["facility"].pk),
            "category": str(categories["slm"].pk),
            "code": "FA-API",
            "name": "Compressor",
            "acquisition_date": str(fy),
            "put_to_use_date": str(month(fy, 0, 16)),
            "cost": "600000",
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    asset_id, version = r.json()["id"], r.json()["version"]
    r = clerk.patch(f"/api/v1/assets/assets/{asset_id}/", {"location": "Bay 2", "version": version + 5}, format="json")
    assert r.status_code == 409
    r = approver.post(f"/api/v1/assets/assets/{asset_id}/capitalize/", {}, format="json")
    assert r.status_code == 400  # Idempotency-Key is required on postings
    r = approver.post(f"/api/v1/assets/assets/{asset_id}/capitalize/", {}, format="json", HTTP_IDEMPOTENCY_KEY="cap-1")
    assert r.status_code == 200 and r.json()["status"] == "capitalized"
    assert gl_balance(books, "1500") == D("600000")

    r = acct.post(
        "/api/v1/assets/depreciation-runs/", {"company": str(books.pk), "period": str(month(fy, 0))}, format="json"
    )
    assert r.status_code == 201, r.content
    run_id = r.json()["id"]
    r = acct.get(f"/api/v1/assets/depreciation-runs/{run_id}/preview/")
    assert r.status_code == 200 and D(r.json()[0]["amount"]) == D("4750")
    r = acct.post(f"/api/v1/assets/depreciation-runs/{run_id}/post/", {}, format="json", HTTP_IDEMPOTENCY_KEY="d-1")
    assert r.status_code == 200 and r.json()["status"] == "posted" and len(r.json()["entries"]) == 1
    r = acct.post(
        "/api/v1/assets/depreciation-runs/", {"company": str(books.pk), "period": str(month(fy, 0))}, format="json"
    )
    assert r.status_code == 422

    r = tech.post(
        "/api/v1/assets/work-orders/",
        {"asset": asset_id, "kind": "breakdown", "description": "Overheating"},
        format="json",
    )
    assert r.status_code == 201, r.content
    wo_id = r.json()["id"]
    r = tech.post(
        f"/api/v1/assets/work-orders/{wo_id}/issue-spares/",
        {
            "on": str(TODAY()),
            "lines": [{"item": str(spares["bearing"].pk), "warehouse": str(plant["rm"].pk), "quantity": "2"}],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="sp-1",
    )
    assert r.status_code == 200, r.content
    assert r.json()["status"] == "in_progress" and D(r.json()["spare_cost"]) == D("500")
    r = tech.post(f"/api/v1/assets/work-orders/{wo_id}/complete/", {"downtime_minutes": 90}, format="json")
    assert r.status_code == 200 and r.json()["downtime_minutes"] == 90
    r = tech.get(f"/api/v1/assets/assets/{asset_id}/reliability/")
    assert r.status_code == 200 and r.json()["failures"] == 1
    r = tech.post(
        "/api/v1/assets/maintenance-plans/",
        {
            "asset": asset_id,
            "name": "Weekly check",
            "trigger": "calendar",
            "interval_days": 7,
            "next_due_date": str(TODAY()),
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    r = tech.post("/api/v1/assets/maintenance-plans/generate/", {"on": str(TODAY())}, format="json")
    assert r.status_code == 200 and r.json()["created"] == 1
    assert MaintenancePlan.objects.get().next_due_date == TODAY() + timedelta(days=7)
    # Visibility follows scope: the technician can't see depreciation runs; the clerk sees assets.
    assert tech.get("/api/v1/assets/depreciation-runs/").status_code == 403
    assert clerk.get("/api/v1/assets/assets/").json()["count"] == 1
    assert Asset.objects.get(pk=asset_id).book_value == D("595250")
