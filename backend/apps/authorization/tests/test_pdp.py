from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.authorization import pdp
from apps.authorization.models import AbacPolicy, ApprovalLimit, Permission, SodRule
from apps.core.models import FeatureFlag
from apps.organization.models import Warehouse

pytestmark = [pytest.mark.django_db, pytest.mark.req("IAM-008")]


def wh_resource(warehouse: Warehouse, **extra) -> pdp.Resource:
    return (
        pdp.Resource.of(warehouse)
        if not extra
        else pdp.Resource.ref(
            "organization.warehouse",
            company_id=warehouse.company_id,
            branch_id=warehouse.branch_id,
            warehouse_id=warehouse.pk,
            **extra,
        )
    )


@pytest.fixture
def site(company, make_branch, make_facility, make_warehouse):
    b1, b2 = make_branch(company, "B1"), make_branch(company, "B2")
    f1 = make_facility(b1, "F1")
    return {
        "b1": b1,
        "b2": b2,
        "f1": f1,
        "w1": make_warehouse(b1, f1, "W1"),  # under B1 / F1
        "w2": make_warehouse(b1, None, "W2"),  # under B1, no facility
        "w3": make_warehouse(b2, None, "W3"),  # other branch
    }


def test_default_deny_without_roles(make_user, ctx, site, catalog):
    user = make_user()
    decision = pdp.authorize(ctx(user), "organization.warehouse.read", pdp.Resource.of(site["w1"]))
    assert not decision.allowed and decision.reason == "no_grant"
    assert not pdp.has_any_grant(ctx(user), "organization.warehouse.read")


def test_unknown_permission_is_denied(make_user, grant, ctx, company, catalog):
    user = make_user()
    grant(user, ["organization.company.read"], company)
    assert pdp.authorize(ctx(user), "organization.company.obliterate").reason == "unknown_permission"


def test_inactive_user_denied(make_user, grant, ctx, company):
    user = make_user(is_active=False)
    grant(user, ["organization.company.read"], company)
    assert pdp.authorize(ctx(user), "organization.company.read", pdp.Resource.of(company)).reason == "inactive_subject"


@pytest.mark.req("IAM-006")
def test_company_scope_grants_everything_in_company(make_user, grant, ctx, site):
    user = make_user()
    grant(user, ["organization.warehouse.read"], site["w1"].company)
    for key in ("w1", "w2", "w3"):
        assert pdp.can(ctx(user), "organization.warehouse.read", pdp.Resource.of(site[key]))


@pytest.mark.req("IAM-006")
def test_branch_scope_includes_descendant_warehouses_only(make_user, grant, ctx, site):
    user = make_user()
    grant(user, ["organization.warehouse.read"], site["b1"])
    assert pdp.can(ctx(user), "organization.warehouse.read", pdp.Resource.of(site["w1"]))
    assert pdp.can(ctx(user), "organization.warehouse.read", pdp.Resource.of(site["w2"]))
    assert not pdp.can(ctx(user), "organization.warehouse.read", pdp.Resource.of(site["w3"]))


def test_facility_scope_without_descendants_excludes_warehouses(make_user, grant, ctx, site):
    user = make_user()
    grant(user, ["organization.warehouse.read"], site["f1"], include_descendants=False)
    assert not pdp.can(ctx(user), "organization.warehouse.read", pdp.Resource.of(site["w1"]))
    user2 = make_user()
    grant(user2, ["organization.warehouse.read"], site["f1"])
    assert pdp.can(ctx(user2), "organization.warehouse.read", pdp.Resource.of(site["w1"]))
    assert not pdp.can(ctx(user2), "organization.warehouse.read", pdp.Resource.of(site["w2"]))


@pytest.mark.req("IAM-006")
def test_warehouse_scope_isolated_from_sibling(make_user, grant, ctx, site):
    user = make_user()
    grant(user, ["organization.warehouse.read"], site["w1"])
    assert pdp.can(ctx(user), "organization.warehouse.read", pdp.Resource.of(site["w1"]))
    assert not pdp.can(ctx(user), "organization.warehouse.read", pdp.Resource.of(site["w2"]))


def test_department_scope_with_subtree(make_user, grant, ctx, company, make_department):
    parent = make_department(company, code="OPS")
    child = make_department(company, parent=parent, code="OPS-MAINT")
    other = make_department(company, code="SALES")
    user = make_user()
    grant(user, ["organization.department.read"], parent)
    assert pdp.can(ctx(user), "organization.department.read", pdp.Resource.of(child))
    assert not pdp.can(ctx(user), "organization.department.read", pdp.Resource.of(other))


def test_validity_window_and_revocation(make_user, grant, ctx, company):
    now = timezone.now()
    future, expired, revoked = make_user(), make_user(), make_user()
    grant(future, ["organization.company.read"], company, valid_from=now + timedelta(days=1))
    grant(
        expired,
        ["organization.company.read"],
        company,
        valid_from=now - timedelta(days=2),
        valid_until=now - timedelta(days=1),
    )
    assignment = grant(revoked, ["organization.company.read"], company)
    res = pdp.Resource.of(company)
    assert not pdp.can(ctx(future), "organization.company.read", res)
    assert not pdp.can(ctx(expired), "organization.company.read", res)
    assert pdp.can(ctx(revoked), "organization.company.read", res)
    assignment.revoked_at = now
    assignment.save()  # signal bumps the authz version: cached snapshot must not survive
    assert not pdp.can(ctx(revoked), "organization.company.read", res)


def test_company_context_mismatch_is_denied(make_user, grant, ctx, org, make_company):
    c1, c2 = make_company("CA"), make_company("CB")
    user = make_user(default_company=c1)
    grant(user, ["organization.company.read"], org)
    assert pdp.can(ctx(user, c1.pk), "organization.company.read", pdp.Resource.of(c2))  # company record itself
    branch_c2 = pdp.Resource.ref("organization.branch", company_id=c2.pk)
    grant(user, ["organization.branch.read"], org)
    assert pdp.authorize(ctx(user, c1.pk), "organization.branch.read", branch_c2).reason == "company_context_mismatch"
    assert pdp.can(ctx(user, c2.pk), "organization.branch.read", branch_c2)


@pytest.mark.req("IAM-007")
def test_deny_policy_overrides_grant(make_user, grant, ctx, org, company):
    user = make_user()
    grant(user, ["identity.user.export"], company)
    AbacPolicy.objects.create(
        organization=org,
        code="no_external_export",
        effect="deny",
        is_active=True,
        actions=["*.*.export"],
        condition={"attr": "env.ip_internal", "op": "eq", "value": False},
    )
    assert pdp.has_any_grant(ctx(user, ip="10.1.2.3"), "identity.user.export")
    decision = pdp.has_any_grant(ctx(user, ip="8.8.8.8"), "identity.user.export")
    assert not decision.allowed and decision.policy == "no_external_export"


def test_deny_policy_with_broken_condition_fails_closed(make_user, grant, ctx, org, company):
    user = make_user()
    grant(user, ["organization.company.read"], company)
    AbacPolicy.objects.create(
        organization=org,
        code="broken",
        effect="deny",
        is_active=True,
        actions=["organization.company.read"],
        condition={"attr": "resource.amount", "op": "gt", "value": "not-a-number-x"},
    )
    res = pdp.Resource.ref("organization.company", scope_fields={"company": "id"}, id=company.pk, amount=5)
    decision = pdp.authorize(ctx(user), "organization.company.read", res)
    assert not decision.allowed and decision.policy == "broken"


@pytest.mark.req("IAM-007")
def test_allow_policy_grants_owner_access_without_role(make_user, ctx, org, company, catalog):
    owner, other = make_user(), make_user()
    AbacPolicy.objects.create(
        organization=org,
        code="own_users",
        effect="allow",
        is_active=True,
        actions=["identity.user.read"],
        resource_types=["identity.user"],
        condition={"attr": "resource.id", "op": "eq", "value": {"attr": "subject.id"}},
    )
    assert pdp.can(ctx(owner), "identity.user.read", pdp.Resource.of(owner))
    assert not pdp.can(ctx(owner), "identity.user.read", pdp.Resource.of(other))
    # Row filtering translates the same condition into SQL.
    from apps.identity.models import User

    visible = pdp.filter_queryset(ctx(owner), "identity.user.read", User.objects.all())
    assert list(visible) == [owner]


@pytest.mark.req("IAM-002")
def test_mfa_required_permission_needs_recent_step_up(make_user, grant, ctx, org):
    user = make_user()
    grant(user, ["authorization.policy.manage"], org)
    assert pdp.has_any_grant(ctx(user, mfa=True), "authorization.policy.manage")
    assert pdp.has_any_grant(ctx(user, mfa=False), "authorization.policy.manage").reason == "mfa_required"


def test_role_requiring_mfa_blocks_unverified_session(make_user, grant, ctx, company):
    user = make_user()
    grant(user, ["organization.company.read"], company, role_mfa_required=True)
    assert pdp.authorize(ctx(user, mfa=False), "organization.company.read").reason == "mfa_required"
    assert pdp.authorize(ctx(user, mfa=True), "organization.company.read").allowed


@pytest.fixture
def approval_perm(catalog):
    """Procurement PO permissions (registered by the procurement module's catalogue)."""
    codes = [
        "procurement.purchase_order.approve",
        "procurement.purchase_order.self_approve",
        "procurement.purchase_order.create",
    ]
    return [Permission.objects.get(code=code) for code in codes]


@pytest.fixture
def procurement_enabled(approval_perm):
    FeatureFlag.objects.create(key="module.procurement", enabled_default=True)


def po(company, created_by, amount="50000", **extra):
    return pdp.Resource.ref(
        "procurement.purchase_order",
        company_id=company.pk,
        created_by_id=created_by.pk,
        amount=Decimal(amount),
        currency="INR",
        **extra,
    )


def test_feature_flag_gates_non_foundation_modules(make_user, grant, ctx, company, approval_perm):
    user = make_user()
    grant(user, ["procurement.purchase_order.create"], company)
    assert pdp.authorize(ctx(user), "procurement.purchase_order.create").reason == "feature_disabled"
    FeatureFlag.objects.create(key="module.procurement", enabled_default=True)
    assert pdp.authorize(ctx(user), "procurement.purchase_order.create").allowed


@pytest.mark.req("IAM-009")
def test_self_approval_blocked_by_default(make_user, grant, ctx, company, procurement_enabled):
    maker = make_user()
    assignment = grant(maker, ["procurement.purchase_order.approve"], company)
    ApprovalLimit.objects.create(
        organization=company.organization,
        role=assignment.role,
        document_type="procurement.purchase_order",
        currency="INR",
        max_amount=Decimal("1000000"),
    )
    decision = pdp.authorize(ctx(maker), "procurement.purchase_order.approve", po(company, maker))
    assert not decision.allowed and decision.reason == "self_approval"


def test_self_approval_requires_explicit_grant_and_mfa(make_user, grant, ctx, company, procurement_enabled):
    maker = make_user()
    assignment = grant(
        maker, ["procurement.purchase_order.approve", "procurement.purchase_order.self_approve"], company
    )
    ApprovalLimit.objects.create(
        organization=company.organization,
        role=assignment.role,
        document_type="procurement.purchase_order",
        currency="INR",
        max_amount=Decimal("1000000"),
    )
    assert pdp.can(ctx(maker, mfa=True), "procurement.purchase_order.approve", po(company, maker))
    assert not pdp.can(ctx(maker, mfa=False), "procurement.purchase_order.approve", po(company, maker))


@pytest.mark.req("IAM-010")
def test_approval_limits(make_user, grant, ctx, company, make_company, procurement_enabled):
    maker, approver = make_user(), make_user()
    assignment = grant(approver, ["procurement.purchase_order.approve"], company)
    action = "procurement.purchase_order.approve"
    assert pdp.authorize(ctx(approver), action, po(company, maker)).reason == "approval_limit"  # no limit row
    ApprovalLimit.objects.create(
        organization=company.organization,
        role=assignment.role,
        document_type="procurement.purchase_order",
        currency="INR",
        max_amount=Decimal("100000"),
    )
    assert pdp.can(ctx(approver), action, po(company, maker, "100000"))
    assert pdp.authorize(ctx(approver), action, po(company, maker, "100000.01")).reason == "approval_limit"
    # A company-specific limit for another company does not apply here.
    other = make_company("OTH")
    ApprovalLimit.objects.create(
        organization=company.organization,
        role=assignment.role,
        company=other,
        document_type="procurement.purchase_order",
        currency="INR",
        max_amount=Decimal("999999999"),
    )
    assert not pdp.can(ctx(approver), action, po(company, maker, "200000"))


@pytest.mark.req("IAM-009")
def test_sod_same_record_rule(make_user, grant, ctx, org, company, procurement_enabled, approval_perm):
    creator, approver = make_user(), make_user()
    a = grant(approver, ["procurement.purchase_order.approve"], company)
    ApprovalLimit.objects.create(
        organization=org,
        role=a.role,
        document_type="procurement.purchase_order",
        currency="INR",
        max_amount=Decimal("1000000"),
    )
    SodRule.objects.create(
        organization=org,
        code="po_mc",
        mode="same_user_same_record",
        permission_a=approval_perm[2],
        permission_b=approval_perm[0],
    )
    action = "procurement.purchase_order.approve"
    # Approver previously amended (create-step) this record via workflow history -> blocked.
    history = {"procurement.purchase_order.create": [approver.pk]}
    decision = pdp.authorize(ctx(approver), action, po(company, creator, action_history=history))
    assert not decision.allowed and decision.reason == "sod"
    assert pdp.can(ctx(approver), action, po(company, creator))
    # Raised as an explained refusal: the API answers 403 with code "sod" (rule code only in the log).
    from apps.core.exceptions import AuthorizationDenied

    with pytest.raises(AuthorizationDenied) as exc:
        pdp.require(ctx(approver), action, po(company, creator, action_history=history))
    assert exc.value.reason == "sod"


def test_scope_filter_matches_object_decisions(make_user, grant, ctx, site):
    user = make_user()
    grant(user, ["organization.warehouse.read"], site["b1"])
    visible = set(pdp.filter_queryset(ctx(user), "organization.warehouse.read", Warehouse.objects.all()))
    assert visible == {site["w1"], site["w2"]}
    nobody = make_user()
    assert not pdp.filter_queryset(ctx(nobody), "organization.warehouse.read", Warehouse.objects.all()).exists()


def test_system_context_is_allowed(system_ctx, catalog):
    assert pdp.authorize(system_ctx, "organization.company.create").allowed


def test_effective_permissions_lists_grants(make_user, grant, ctx, site):
    user = make_user()
    grant(user, ["organization.warehouse.read", "organization.warehouse.update"], site["w1"])
    perms = pdp.effective_permissions(ctx(user))
    assert perms["codes"] == ["organization.warehouse.read", "organization.warehouse.update"]
    assert perms["grants"]["organization.warehouse.read"][0]["scope_type"] == "warehouse"
