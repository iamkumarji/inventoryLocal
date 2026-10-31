"""Multi-tenant isolation: one organization's administrator, holding every permission, can't see, open,
reference or switch anything of another organization. Platform operators run tenants without
reading their data."""

import pytest
from django.utils import timezone

from apps.authorization import services as authz
from apps.authorization.models import Permission
from apps.authorization.tests.test_endpoint_matrix import ENDPOINTS
from apps.core import flags
from apps.core.context import ActorContext
from apps.core.models import FeatureFlag
from apps.identity.models import User
from apps.masterdata.models import Item, ItemCategory, Uom
from apps.organization import services as org_services
from apps.partners.models import Partner
from apps.platform import services

pytestmark = [pytest.mark.django_db, pytest.mark.req("ADM-010")]
PASSWORD = "Tenant-Admin-Passw0rd!"


@pytest.fixture
def operator(db):
    return User.objects.create_user("ops@platform.example", PASSWORD, full_name="Ops", is_platform_operator=True)


def op_ctx(operator, mfa=True):
    return ActorContext(user=operator, mfa_verified_at=timezone.now() if mfa else None, client_type="web")


def provision(operator, code):
    result = services.provision_organization(
        op_ctx(operator),
        code=code,
        name=f"{code} Industries",
        company_code=f"{code}01",
        company_name=f"{code} Industries Pvt Ltd",
        admin_email=f"admin@{code.lower()}.example",
        admin_name=f"{code} Admin",
        admin_password=PASSWORD,
    )
    system = ActorContext.system("test")
    # Every read permission (segregation-of-duties rules rightly refuse an "everything" role), plus the
    # two writes the tests use.
    codes = [c for c in Permission.objects.values_list("code", flat=True) if c.endswith(".read")]
    role = authz.create_role(
        system,
        organization=result.organization,
        code="reader",
        name="Reads everything",
        permission_codes=[*codes, "masterdata.item.create", "core.feature_flag.manage"],
    )
    authz.assign_role(
        system, user=result.admin, role=role, scope_type="organization", scope_id=result.organization.pk, reason="test"
    )
    branch = org_services.create_branch(system, company=result.company, code=f"{code}-BR", name="Branch")
    warehouse = org_services.create_warehouse(
        system, branch=branch, code=f"{code}-WH", name="Store", warehouse_type="raw_material"
    )
    uom = Uom.objects.create(organization=result.organization, code="KG", name="Kilogram", kind="mass", decimals=3)
    category = ItemCategory.objects.create(organization=result.organization, code="RM", name="Raw", posting_group="RM")
    item = Item.objects.create(
        organization=result.organization,
        code=f"{code}-STEEL",
        name="Steel",
        item_type="raw_material",
        category=category,
        stock_uom=uom,
    )
    partner = Partner.objects.create(
        organization=result.organization,
        code=f"{code}-SUP",
        name=f"{code} Supplier",
        is_supplier=True,
        gst_registration="unregistered",
    )
    return {
        "org": result.organization,
        "company": result.company,
        "admin": result.admin,
        "role": role,
        "branch": branch,
        "warehouse": warehouse,
        "uom": uom,
        "category": category,
        "item": item,
        "partner": partner,
    }


@pytest.fixture
def tenants(operator):
    flags.register_module_flags()
    FeatureFlag.objects.filter(key__startswith="module.").update(enabled_default=True)
    flags.invalidate()
    return provision(operator, "ALPHA"), provision(operator, "BETA")


def client_for(api_for, tenant):
    return api_for(tenant["admin"], company=tenant["company"])


def secret_ids(tenant) -> set[str]:
    return {
        str(tenant[k].pk)
        for k in ("org", "company", "admin", "role", "branch", "warehouse", "uom", "category", "item", "partner")
    }


def test_lists_never_show_another_organizations_records(tenants, api_for):
    alpha, beta = tenants
    client = client_for(api_for, alpha)
    hidden = secret_ids(beta)
    checked = 0
    for path, view, methods in ENDPOINTS:
        if "get" not in methods or re_has_id(path) or path.endswith(("/schema/", "/docs/", "/redoc/")):
            continue
        response = client.get(path)
        if response.status_code != 200 or not response.content:
            continue
        checked += 1
        body = response.content.decode()
        leaked = [i for i in hidden if i in body]
        assert not leaked, f"{path} shows another organization's records: {leaked}"
    assert checked > 60  # the crawl really ran over the API


def re_has_id(path: str) -> bool:
    import re

    return bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", path))


@pytest.mark.parametrize(
    ("url", "key"),
    [
        ("/api/v1/masterdata/items/{}/", "item"),
        ("/api/v1/masterdata/uoms/{}/", "uom"),
        ("/api/v1/partners/{}/", "partner"),
        ("/api/v1/organization/companies/{}/", "company"),
        ("/api/v1/organization/warehouses/{}/", "warehouse"),
        ("/api/v1/identity/users/{}/", "admin"),
        ("/api/v1/authorization/roles/{}/", "role"),
    ],
)
def test_another_organizations_records_cant_be_opened(tenants, api_for, url, key):
    alpha, beta = tenants
    response = client_for(api_for, alpha).get(url.format(beta[key].pk))
    assert response.status_code == 404, response.content


def test_another_organizations_records_cant_be_referenced(tenants, api_for):
    alpha, beta = tenants
    response = client_for(api_for, alpha).post(
        "/api/v1/masterdata/items/",
        {
            "code": "SNEAKY",
            "name": "Sneaky",
            "item_type": "raw_material",
            "category": str(beta["category"].pk),
            "stock_uom": str(beta["uom"].pk),
        },
        format="json",
    )
    assert response.status_code == 400
    errors = response.json().get("errors", [])
    fields = {e.get("field") for e in errors} if isinstance(errors, list) else set(errors)
    assert {"category", "stock_uom"} <= fields, errors


def test_company_header_of_another_organization_is_ignored(tenants, api_for):
    alpha, beta = tenants
    client = api_for(alpha["admin"], company=beta["company"])  # forged X-Company-ID
    items = client.get("/api/v1/masterdata/items/").content.decode()
    assert str(beta["item"].pk) not in items


def test_feature_flags_are_per_organization(tenants, api_for):
    alpha, beta = tenants
    flag = FeatureFlag.objects.get(key="module.inventory")
    client = client_for(api_for, alpha)
    response = client.patch(f"/api/v1/admin/feature-flags/{flag.pk}/", {"enabled_default": False}, format="json")
    assert response.status_code == 200 and response.json()["enabled_default"] is False
    assert not flags.is_enabled("module.inventory", organization_id=alpha["org"].pk)
    assert flags.is_enabled("module.inventory", organization_id=beta["org"].pk)  # untouched
    flag.refresh_from_db()
    assert flag.enabled_default is True  # platform default unchanged
    beta_view = client_for(api_for, beta).get("/api/v1/admin/feature-flags/").json()
    assert next(f for f in beta_view if f["key"] == "module.inventory")["enabled_default"] is True
    # Targeting rules can only name the organization's own users and companies.
    response = client.patch(
        f"/api/v1/admin/feature-flags/{flag.pk}/", {"rules": {"users": {str(beta["admin"].pk): True}}}, format="json"
    )
    assert response.status_code == 400


def test_suspension_blocks_sign_in_and_ends_sessions(tenants, operator, api_for):
    alpha, beta = tenants
    session_client = client_for(api_for, beta)
    assert session_client.get("/api/v1/auth/me/").status_code == 200
    services.set_active(op_ctx(operator), beta["org"], active=False, reason="Unpaid invoice")
    assert session_client.get("/api/v1/auth/me/").status_code == 401
    from rest_framework.test import APIClient

    login = APIClient().post(
        "/api/v1/auth/login/",
        {"email": beta["admin"].email, "password": PASSWORD, "client_type": "mobile"},
        format="json",
    )
    assert login.status_code in (400, 401)
    assert client_for(api_for, alpha).get("/api/v1/auth/me/").status_code == 200  # other tenants unaffected
    services.set_active(op_ctx(operator), beta["org"], active=True, reason="Paid")
    login = APIClient().post(
        "/api/v1/auth/login/",
        {"email": beta["admin"].email, "password": PASSWORD, "client_type": "mobile"},
        format="json",
    )
    assert login.status_code == 200


def test_platform_console_is_operator_only(tenants, operator, api_for):
    alpha, _ = tenants
    assert client_for(api_for, alpha).get("/api/v1/platform/organizations/").status_code == 403
    assert api_for(operator, mfa=False).get("/api/v1/platform/organizations/").status_code == 403
    response = api_for(operator).get("/api/v1/platform/organizations/")
    assert response.status_code == 200
    rows = {r["code"]: r for r in response.json()}
    assert set(rows) >= {"ALPHA", "BETA"} and rows["ALPHA"]["users"] == 1
    assert set(rows["ALPHA"]) == {
        "id",
        "code",
        "name",
        "is_active",
        "base_currency",
        "timezone",
        "users",
        "companies",
        "created_at",
    }  # directory figures only
    # Operators hold no grants inside tenants: business endpoints refuse them.
    assert api_for(operator).get("/api/v1/masterdata/items/").status_code in (403, 404)


def test_operator_provisions_a_ready_organization(operator, api_for):
    response = api_for(operator).post(
        "/api/v1/platform/organizations/",
        {
            "code": "GAMMA",
            "name": "Gamma Foods",
            "company_code": "GAM01",
            "company_name": "Gamma Foods Pvt Ltd",
            "admin_email": "owner@gamma.example",
            "admin_name": "Gamma Owner",
            "admin_password": PASSWORD,
        },
        format="json",
    )
    assert response.status_code == 201, response.content
    admin = User.objects.get(email="owner@gamma.example")
    assert admin.must_change_password and admin.mfa_enforced and admin.organization.code == "GAMMA"
    assert admin.organization.companies.get().fiscal_years.exists()
    from apps.finance.models import Account

    assert Account.objects.filter(company__organization=admin.organization).exists()  # chart installed
    duplicate = api_for(operator).post(
        "/api/v1/platform/organizations/",
        {
            "code": "GAMMA",
            "name": "x",
            "company_code": "X1",
            "company_name": "x",
            "admin_email": "x@x.example",
            "admin_name": "x",
            "admin_password": PASSWORD,
        },
        format="json",
    )
    assert duplicate.status_code == 400
