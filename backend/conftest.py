"""Shared fixtures. Tests run against real PostgreSQL: constraints and triggers are part of the design."""

from __future__ import annotations

import itertools
from datetime import date
from decimal import Decimal

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.authorization import snapshot as authz_snapshot
from apps.authorization.models import Permission, Role, RoleAssignment, RolePermission
from apps.authorization.seeding import sync_permissions
from apps.core import flags
from apps.core.context import ActorContext
from apps.identity import services as identity_services
from apps.identity.models import User
from apps.organization.models import Branch, Company, Department, Facility, Organization, Warehouse

_seq = itertools.count(1)
PASSWORD = "Correct-Horse-Battery-9"


@pytest.fixture(autouse=True)
def _isolate_caches():
    cache.clear()
    authz_snapshot._local.clear()
    flags.invalidate()
    yield
    cache.clear()
    authz_snapshot._local.clear()


@pytest.fixture
def system_ctx() -> ActorContext:
    return ActorContext.system("tests")


@pytest.fixture
def catalog(db):
    sync_permissions()
    return Permission.objects.all()


@pytest.fixture
def org(db) -> Organization:
    return Organization.objects.create(code=f"ORG{next(_seq)}", name="Test Org")


@pytest.fixture
def make_company(org):
    def _make(code: str | None = None, **kw) -> Company:
        return Company.objects.create(
            organization=kw.pop("organization", org),
            code=code or f"C{next(_seq)}",
            legal_name=kw.pop("legal_name", "Test Company Pvt Ltd"),
            **kw,
        )

    return _make


@pytest.fixture
def company(make_company) -> Company:
    return make_company("C1")


@pytest.fixture
def make_branch():
    def _make(company: Company, code: str | None = None) -> Branch:
        return Branch.objects.create(company=company, code=code or f"B{next(_seq)}", name="Branch")

    return _make


@pytest.fixture
def make_facility():
    def _make(branch: Branch, code: str | None = None) -> Facility:
        return Facility.objects.create(
            company=branch.company, branch=branch, code=code or f"F{next(_seq)}", name="Plant", facility_type="plant"
        )

    return _make


@pytest.fixture
def make_warehouse():
    def _make(branch: Branch, facility: Facility | None = None, code: str | None = None, **kw) -> Warehouse:
        return Warehouse.objects.create(
            company=branch.company,
            branch=branch,
            facility=facility,
            code=code or f"W{next(_seq)}",
            name="Store",
            warehouse_type=kw.pop("warehouse_type", "raw_material"),
            **kw,
        )

    return _make


@pytest.fixture
def make_department():
    def _make(company: Company, parent: Department | None = None, code: str | None = None) -> Department:
        return Department.objects.create(company=company, parent=parent, code=code or f"D{next(_seq)}", name="Dept")

    return _make


@pytest.fixture
def make_user(org, company):
    def _make(email: str | None = None, **kw) -> User:
        kw.setdefault("organization", org)
        kw.setdefault("default_company", company)
        return User.objects.create_user(
            email or f"user{next(_seq)}@example.com", PASSWORD, full_name=kw.pop("full_name", "Test User"), **kw
        )

    return _make


@pytest.fixture
def make_role(org, catalog):
    def _make(codes: list[str], code: str | None = None, **kw) -> Role:
        role = Role.objects.create(organization=org, code=code or f"role{next(_seq)}", name="Role", **kw)
        perms = Permission.objects.filter(code__in=codes)
        missing = set(codes) - set(perms.values_list("code", flat=True))
        assert not missing, f"unknown permissions in test: {missing}"
        RolePermission.objects.bulk_create([RolePermission(role=role, permission=p) for p in perms])
        return role

    return _make


@pytest.fixture
def grant(make_role):
    """grant(user, ["perm.code", ...], scope_obj, **assignment_kwargs) -> RoleAssignment"""

    def _grant(
        user: User, codes: list[str], scope, scope_type: str | None = None, role: Role | None = None, **kw
    ) -> RoleAssignment:
        role = role or make_role(codes, mfa_required=kw.pop("role_mfa_required", False))
        scope_type = (
            scope_type
            or {
                Organization: "organization",
                Company: "company",
                Branch: "branch",
                Facility: "facility",
                Warehouse: "warehouse",
                Department: "department",
            }[type(scope)]
        )
        company_id = (
            None if scope_type == "organization" else (scope.pk if scope_type == "company" else scope.company_id)
        )
        return RoleAssignment.objects.create(
            user=user,
            role=role,
            organization=role.organization,
            scope_type=scope_type,
            scope_id=scope.pk,
            company_id=company_id,
            **kw,
        )

    return _grant


def ctx_for(user: User, company_id=None, *, mfa: bool = True, client_type: str = "web", ip: str = "10.0.0.5"):
    from django.utils import timezone

    return ActorContext(
        user=user,
        company_id=company_id if company_id is not None else user.default_company_id,
        mfa_verified_at=timezone.now() if mfa else None,
        client_type=client_type,
        ip=ip,
    )


@pytest.fixture
def ctx():
    return ctx_for


@pytest.fixture
def api_for():
    """Authenticated API client using a bearer session (mobile-style, no CSRF)."""

    def _client(user: User, *, mfa: bool = True, company=None, restricted: str = "") -> APIClient:
        client = APIClient()
        info = identity_services.ClientInfo(client_type="mobile", ip="10.0.0.9")
        session, token = identity_services.create_session(user, info, mfa_verified=mfa, restricted_reason=restricted)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        if company is not None:
            client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}", HTTP_X_COMPANY_ID=str(company.pk))
        client.session_obj = session
        return client

    return _client


@pytest.fixture
def fiscal_year(company, system_ctx):
    from apps.organization.services import create_fiscal_year

    return create_fiscal_year(
        system_ctx, company=company, start_year=date.today().year - (1 if date.today().month < 4 else 0)
    )


# --- Business fixtures (master data, books of account) ----------------------------------------


@pytest.fixture
def books(company, fiscal_year, system_ctx):
    """Company with an open fiscal year and the template chart of accounts installed."""
    from apps.finance.services import install_chart

    install_chart(system_ctx, company)
    return company


@pytest.fixture
def uoms(org):
    from apps.masterdata.models import Uom, UomConversion

    nos = Uom.objects.create(organization=org, code="NOS", name="Numbers", kind="count", decimals=0)
    kg = Uom.objects.create(organization=org, code="KG", name="Kilogram", kind="mass", decimals=3)
    bag = Uom.objects.create(organization=org, code="BAG", name="Bag", kind="count", decimals=0)
    UomConversion.objects.create(organization=org, from_uom=bag, to_uom=kg, factor=Decimal("25"))
    return {"nos": nos, "kg": kg, "bag": bag}


@pytest.fixture
def make_item(org, uoms):
    from apps.masterdata.models import Item, ItemCategory

    categories = {}

    def _make(code: str | None = None, group: str = "RM", uom: str = "kg", **kw) -> Item:
        if group not in categories:
            categories[group] = ItemCategory.objects.create(
                organization=org, code=f"CAT-{group}", name=group, posting_group=group
            )
        return Item.objects.create(
            organization=org,
            code=code or f"I{next(_seq)}",
            name=kw.pop("name", "Item"),
            item_type=kw.pop("item_type", "raw_material"),
            category=categories[group],
            stock_uom=uoms[uom],
            **kw,
        )

    return _make


@pytest.fixture
def plant(books, make_branch, make_facility, make_warehouse):
    branch = make_branch(books, "PLT")
    facility = make_facility(branch, "PLT-F1")
    return {
        "branch": branch,
        "facility": facility,
        "rm": make_warehouse(branch, facility, "RM", warehouse_type="raw_material"),
        "rm2": make_warehouse(branch, None, "RM2", warehouse_type="raw_material"),
        "wip": make_warehouse(branch, facility, "WIP", warehouse_type="wip"),
        "fg": make_warehouse(branch, None, "FG", warehouse_type="finished_goods"),
        "qc": make_warehouse(branch, None, "QC", warehouse_type="quarantine"),
    }


def gl_balance(company, code: str):
    """Debit-positive balance of a GL account (posted entries only)."""
    from django.db.models import Sum

    from apps.finance.models import JournalLine

    agg = JournalLine.objects.filter(entry__company=company, entry__status="posted", account__code=code).aggregate(
        dr=Sum("debit"), cr=Sum("credit")
    )
    return (agg["dr"] or Decimal("0")) - (agg["cr"] or Decimal("0"))
