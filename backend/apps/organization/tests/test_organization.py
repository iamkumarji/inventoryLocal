from datetime import date

import pytest
from django.db import IntegrityError, transaction
from rest_framework.exceptions import ValidationError

from apps.audit.models import AuditEvent
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation
from apps.organization import services
from apps.organization.models import FiscalYear, Warehouse

pytestmark = pytest.mark.django_db


@pytest.mark.req("FND-002")
def test_fiscal_year_april_to_march_with_monthly_periods(company, system_ctx):
    fy = services.create_fiscal_year(system_ctx, company=company, start_year=2026)
    assert (fy.code, fy.start_date, fy.end_date) == ("FY2026-27", date(2026, 4, 1), date(2027, 3, 31))
    periods = list(fy.periods.all())
    assert len(periods) == 12
    assert (periods[10].start_date, periods[10].end_date) == (date(2027, 2, 1), date(2027, 2, 28))
    assert all(a.end_date.toordinal() + 1 == b.start_date.toordinal() for a, b in zip(periods, periods[1:]))


def test_overlapping_fiscal_years_rejected_by_service_and_database(company, system_ctx):
    services.create_fiscal_year(system_ctx, company=company, start_year=2026)
    with pytest.raises(BusinessRuleViolation):
        services.create_fiscal_year(system_ctx, company=company, start_year=2026)
    with pytest.raises(IntegrityError), transaction.atomic():  # exclusion constraint backstop
        FiscalYear.objects.create(company=company, code="X", start_date=date(2026, 10, 1), end_date=date(2027, 9, 30))


@pytest.mark.req("FND-003")
def test_gapless_numbering_and_rollback_releases_number(company, fiscal_year):
    on = fiscal_year.start_date
    with transaction.atomic():
        first = services.allocate_number(company.pk, "PO", on)
        second = services.allocate_number(company.pk, "PO", on)
    short = fiscal_year.code.removeprefix("FY")
    assert (first, second) == (f"PO/{short}/000001", f"PO/{short}/000002")
    try:
        with transaction.atomic():
            services.allocate_number(company.pk, "PO", on)
            raise RuntimeError("posting failed")
    except RuntimeError:
        pass
    with transaction.atomic():
        assert services.allocate_number(company.pk, "PO", on) == f"PO/{short}/000003"
        assert services.allocate_number(company.pk, "GRN", on) == f"GRN/{short}/000001"


@pytest.mark.django_db(transaction=True)
def test_numbering_requires_transaction(company, fiscal_year):
    with pytest.raises(RuntimeError):
        services.allocate_number(company.pk, "PO", fiscal_year.start_date)


def test_numbering_requires_fiscal_year(company, fiscal_year):
    with pytest.raises(BusinessRuleViolation), transaction.atomic():
        services.allocate_number(company.pk, "PO", date(1999, 1, 1))


def test_period_lock_guard(company, fiscal_year):
    period = fiscal_year.periods.first()
    assert services.ensure_period_open(company.pk, period.start_date, "inventory") == period
    period.inventory_locked = True
    period.save()
    with pytest.raises(BusinessRuleViolation, match="locked"):
        services.ensure_period_open(company.pk, period.start_date, "inventory")
    assert services.ensure_period_open(company.pk, period.start_date, "gl")


def test_hierarchy_validation(company, make_company, make_branch, make_facility, make_department, system_ctx):
    b1, b2 = make_branch(company), make_branch(company)
    f_other = make_facility(b2)
    with pytest.raises(ValidationError):
        services.create_warehouse(
            system_ctx, branch=b1, facility=f_other, code="WX", name="X", warehouse_type="general"
        )
    other_company_dept = make_department(make_company("ZZ"))
    with pytest.raises(ValidationError):
        services.create_department(system_ctx, company=company, parent=other_company_dept, code="D", name="D")
    parent = make_department(company)
    child = make_department(company, parent=parent)
    with pytest.raises(ValidationError, match="cycles"):
        services.update_node(system_ctx, parent, {"parent": child}, parent.version)


def test_gstin_format_enforced_in_database(company):
    company.gstin = "NOT-A-GSTIN"
    with pytest.raises(IntegrityError), transaction.atomic():
        company.save()
    company.gstin = "27AAPFU0939F1ZV"
    company.save()


def test_create_requires_permission_in_scope(make_user, grant, ctx, company, make_branch):
    b1, b2 = make_branch(company), make_branch(company)
    user = make_user()
    grant(user, ["organization.warehouse.create"], b1)
    services.create_warehouse(ctx(user), branch=b1, code="W-OK", name="ok", warehouse_type="general")
    with pytest.raises(AuthorizationDenied):
        services.create_warehouse(ctx(user), branch=b2, code="W-NO", name="no", warehouse_type="general")
    # Allowing negative stock is a separate administrative permission (configuration, not code).
    with pytest.raises(AuthorizationDenied):
        services.create_warehouse(
            ctx(user), branch=b1, code="W-NEG", name="neg", warehouse_type="general", allow_negative_stock=True
        )
    assert AuditEvent.objects.filter(action="organization.warehouse.created").count() == 1


# --- API ---------------------------------------------------------------------------------------


def test_warehouse_scoped_user_sees_only_their_warehouse(
    make_user, grant, api_for, company, make_branch, make_warehouse
):
    branch = make_branch(company)
    mine, other = make_warehouse(branch), make_warehouse(branch)
    user = make_user()
    grant(user, ["organization.warehouse.read"], mine)
    client = api_for(user)
    results = client.get("/api/v1/organization/warehouses/").json()["results"]
    assert [r["id"] for r in results] == [str(mine.pk)]
    assert client.get(f"/api/v1/organization/warehouses/{other.pk}/").status_code == 404


def test_update_with_optimistic_locking_and_audit(make_user, grant, api_for, company, make_branch, make_warehouse):
    warehouse = make_warehouse(make_branch(company))
    user = make_user()
    grant(user, ["organization.warehouse.read", "organization.warehouse.update"], company)
    client = api_for(user)
    url = f"/api/v1/organization/warehouses/{warehouse.pk}/"
    ok = client.patch(url, {"name": "Main RM Store", "version": 1}, format="json")
    assert ok.status_code == 200 and ok.json()["version"] == 2
    stale = client.patch(url, {"name": "Lost update", "version": 1}, format="json")
    assert stale.status_code == 409 and stale.json()["type"] == "version_conflict"
    code_change = client.patch(url, {"code": "NEW", "version": 2}, format="json")
    assert code_change.status_code == 200 and code_change.json()["code"] == warehouse.code  # code is read-only
    negative = client.patch(url, {"allow_negative_stock": True, "version": 2}, format="json")
    assert negative.status_code == 403  # needs organization.warehouse.manage
    event = AuditEvent.objects.get(action="organization.warehouse.updated")
    assert event.changes == {"name": {"from": "Store", "to": "Main RM Store"}}


def test_company_header_must_be_accessible(make_user, grant, api_for, make_company):
    c1, c2 = make_company("H1"), make_company("H2")
    user = make_user(default_company=c1)
    grant(user, ["organization.branch.read"], c1)
    assert api_for(user, company=c1).get("/api/v1/organization/branches/").status_code == 200
    denied = api_for(user, company=c2).get("/api/v1/organization/branches/")
    assert denied.status_code == 403


def test_branch_create_rejects_out_of_scope_company(make_user, grant, api_for, make_company):
    c1, c2 = make_company("S1"), make_company("S2")
    user = make_user(default_company=c1)
    grant(user, ["organization.branch.create", "organization.company.read"], c1)
    client = api_for(user)
    ok = client.post(
        "/api/v1/organization/branches/", {"company": str(c1.pk), "code": "BR1", "name": "Pune"}, format="json"
    )
    assert ok.status_code == 201
    bad = client.post(
        "/api/v1/organization/branches/", {"company": str(c2.pk), "code": "BR2", "name": "X"}, format="json"
    )
    assert bad.status_code == 400 and bad.json()["errors"][0]["field"] == "company"
    duplicate = client.post(
        "/api/v1/organization/branches/", {"company": str(c1.pk), "code": "BR1", "name": "Y"}, format="json"
    )
    assert duplicate.status_code == 400


def test_scope_tree(make_user, grant, api_for, company, make_branch, make_warehouse):
    b1, b2 = make_branch(company, "T1"), make_branch(company, "T2")
    w1 = make_warehouse(b1)
    make_warehouse(b2)
    user = make_user()
    grant(user, ["organization.warehouse.read"], w1)
    tree = api_for(user).get("/api/v1/organization/scope-tree/").json()["companies"]
    assert len(tree) == 1
    assert [b["code"] for b in tree[0]["branches"]] == ["T1"]
    assert [w["id"] for w in tree[0]["branches"][0]["warehouses"]] == [str(w1.pk)]


def test_no_delete_endpoints_for_structure(make_user, grant, api_for, company, make_branch, make_warehouse):
    warehouse = make_warehouse(make_branch(company))
    user = make_user()
    grant(user, ["organization.warehouse.read", "organization.warehouse.update"], company)
    response = api_for(user).delete(f"/api/v1/organization/warehouses/{warehouse.pk}/")
    assert response.status_code == 405
    assert Warehouse.objects.filter(pk=warehouse.pk).exists()
