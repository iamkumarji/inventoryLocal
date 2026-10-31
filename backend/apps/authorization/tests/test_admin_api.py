import pytest

from apps.audit.models import AuditEvent
from apps.authorization.models import Permission, Role, RoleAssignment, SodRule
from apps.authorization.seeding import resolve_patterns, seed_templates

pytestmark = pytest.mark.django_db
ROLES = "/api/v1/authorization/roles/"
ASSIGN = "/api/v1/authorization/role-assignments/"


@pytest.fixture
def security_admin(make_user, grant, org):
    user = make_user(email="secadmin@example.com")
    grant(
        user,
        [
            "authorization.role.create",
            "authorization.role.read",
            "authorization.role.update",
            "authorization.role.manage",
            "authorization.role_assignment.read",
            "authorization.role_assignment.assign",
            "authorization.policy.read",
            "authorization.policy.manage",
            "authorization.sod_rule.read",
            "authorization.sod_rule.manage",
            "authorization.approval_limit.read",
            "authorization.approval_limit.manage",
            "authorization.permission.read",
        ],
        org,
    )
    return user


def test_role_lifecycle(security_admin, api_for):
    client = api_for(security_admin)
    created = client.post(
        ROLES,
        {
            "code": "store_keeper_pune",
            "name": "Store keeper (Pune)",
            "permission_codes": ["organization.warehouse.read"],
        },
        format="json",
    )
    assert created.status_code == 201, created.json()
    role = created.json()
    assert role["permission_codes"] == ["organization.warehouse.read"]
    updated = client.put(
        f"{ROLES}{role['id']}/permissions/",
        {
            "permission_codes": ["organization.warehouse.read", "organization.warehouse.update"],
            "version": role["version"],
        },
        format="json",
    )
    assert updated.status_code == 200 and len(updated.json()["permission_codes"]) == 2
    stale = client.patch(f"{ROLES}{role['id']}/", {"name": "x", "version": role["version"]}, format="json")
    assert stale.status_code == 409
    unknown = client.post(
        ROLES, {"code": "bad_role", "name": "Bad", "permission_codes": ["no.such.perm"]}, format="json"
    )
    assert unknown.status_code == 400
    assert AuditEvent.objects.filter(action="authorization.role.permissions_changed").exists()


def test_templates_are_read_only_but_cloneable(security_admin, api_for, org, catalog):
    seed_templates(org)
    template = Role.objects.get(organization=org, code="tpl_system_admin")
    client = api_for(security_admin)
    edit = client.patch(f"{ROLES}{template.pk}/", {"name": "hacked", "version": template.version}, format="json")
    assert edit.status_code == 422 and edit.json()["code"] == "role_template_read_only"
    clone = client.post(
        f"{ROLES}{template.pk}/clone/", {"code": "sysadmin_plant", "name": "Plant sysadmin"}, format="json"
    )
    assert clone.status_code == 201
    assert set(clone.json()["permission_codes"]) == set(
        template.role_permissions.values_list("permission__code", flat=True)
    )
    assert client.post(ROLES, {"code": "tpl_mine", "name": "x"}, format="json").status_code == 400


def test_template_patterns_never_grant_business_postings_to_sysadmin(org, catalog):
    seed_templates(org)
    codes = set(
        Role.objects.get(organization=org, code="tpl_system_admin").role_permissions.values_list(
            "permission__code", flat=True
        )
    )
    assert "authorization.role.manage" in codes
    assert not any(c.endswith((".approve", ".post")) for c in codes)
    # Financial controls and the audit trail are outside IT administration (segregation of duties).
    assert {
        "authorization.approval_limit.manage",
        "approvals.approval_matrix.manage",
        "audit.audit_event.manage",
    }.isdisjoint(codes)
    finance = set(
        Role.objects.get(organization=org, code="tpl_finance_controller").role_permissions.values_list(
            "permission__code", flat=True
        )
    )
    assert {"authorization.approval_limit.manage", "approvals.approval_matrix.manage"} <= finance
    assert resolve_patterns(["*.*.read", "!audit.*.*"], ["a.b.read", "audit.audit_event.read", "a.b.update"]) == {
        "a.b.read"
    }


def test_assign_and_revoke_with_audit(security_admin, api_for, make_user, make_role, company):
    target = make_user()
    role = make_role(["organization.company.read"])
    client = api_for(security_admin)
    created = client.post(
        ASSIGN,
        {
            "user": str(target.pk),
            "role": str(role.pk),
            "scope_type": "company",
            "scope_id": str(company.pk),
            "reason": "New hire",
        },
        format="json",
    )
    assert created.status_code == 201, created.json()
    assignment_id = created.json()["id"]
    assert created.json()["company"] == str(company.pk)
    revoked = client.post(f"{ASSIGN}{assignment_id}/revoke/", {"reason": "Left"}, format="json")
    assert revoked.status_code == 200 and revoked.json()["is_effective"] is False
    assert {"authorization.role.assigned", "authorization.role.revoked"} <= set(
        AuditEvent.objects.values_list("action", flat=True)
    )


def test_assignment_validations(security_admin, api_for, make_role, company, make_user):
    role = make_role(["organization.company.read"])
    client = api_for(security_admin)
    bogus_scope = client.post(
        ASSIGN,
        {
            "user": str(make_user().pk),
            "role": str(role.pk),
            "scope_type": "branch",
            "scope_id": str(company.pk),
            "reason": "x",
        },
        format="json",
    )
    assert bogus_scope.status_code == 400  # company id passed as a branch
    self_grant = client.post(
        ASSIGN,
        {
            "user": str(security_admin.pk),
            "role": str(role.pk),
            "scope_type": "company",
            "scope_id": str(company.pk),
            "reason": "x",
        },
        format="json",
    )
    assert self_grant.status_code == 422 and self_grant.json()["code"] == "self_grant"


@pytest.mark.req("IAM-009")
def test_sod_same_user_rule_blocks_conflicting_assignment(
    security_admin, api_for, make_role, make_user, org, company, grant
):
    a = Permission.objects.get(code="identity.user.manage")
    b = Permission.objects.get(code="audit.audit_event.manage")
    SodRule.objects.create(
        organization=org, code="admin_vs_audit", permission_a=a, permission_b=b, mode="same_user_any"
    )
    target = make_user()
    grant(target, ["identity.user.manage"], org)
    auditor_role = make_role(["audit.audit_event.manage"])
    response = api_for(security_admin).post(
        ASSIGN,
        {
            "user": str(target.pk),
            "role": str(auditor_role.pk),
            "scope_type": "company",
            "scope_id": str(company.pk),
            "reason": "x",
        },
        format="json",
    )
    assert response.status_code == 422 and response.json()["code"] == "sod_conflict"
    assert not RoleAssignment.objects.filter(user=target, role=auditor_role).exists()


def test_policy_validation_and_creation_requires_step_up(security_admin, api_for):
    client = api_for(security_admin)
    invalid = client.post(
        "/api/v1/authorization/policies/validate/",
        {"effect": "allow", "actions": ["bad"], "condition": {"attr": "x", "op": "eq"}},
        format="json",
    ).json()
    assert invalid["valid"] is False and len(invalid["errors"]) == 2
    payload = {
        "code": "deny_late_exports",
        "effect": "deny",
        "actions": ["*.*.export"],
        "condition": {"not": {"attr": "env.time", "op": "time_between", "value": ["07:00", "21:00"]}},
        "is_active": True,
    }
    assert (
        api_for(security_admin, mfa=False).post("/api/v1/authorization/policies/", payload, format="json").status_code
        == 403
    )
    created = client.post("/api/v1/authorization/policies/", payload, format="json")
    assert created.status_code == 201, created.json()
    unconditional_allow = client.post(
        "/api/v1/authorization/policies/",
        {"code": "allow_everything", "effect": "allow", "actions": ["*.*.*"], "condition": {}},
        format="json",
    )
    assert unconditional_allow.status_code == 400


def test_approval_limit_upsert_and_check_endpoint(security_admin, api_for, make_role, make_user, company):
    role = make_role(["organization.company.read"])
    client = api_for(security_admin)
    url = "/api/v1/authorization/approval-limits/"
    first = client.post(
        url,
        {
            "role": str(role.pk),
            "document_type": "procurement.purchase_order",
            "currency": "INR",
            "max_amount": "100000.00",
        },
        format="json",
    )
    second = client.post(
        url,
        {
            "role": str(role.pk),
            "document_type": "procurement.purchase_order",
            "currency": "INR",
            "max_amount": "250000.00",
        },
        format="json",
    )
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"] and second.json()["max_amount"] == "250000.0000"

    target = make_user()
    explain = client.post(
        "/api/v1/authorization/check/",
        {
            "user": str(target.pk),
            "action": "organization.company.read",
            "resource_type": "organization.company",
            "resource_attributes": {"id": str(company.pk)},
        },
        format="json",
    )
    assert explain.status_code == 200 and explain.json() == {
        "allowed": False,
        "reason": "no_grant",
        "policy": None,
        "obligations": [],
    }
