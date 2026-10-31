"""Organization MFA policy: administrators choose whether everyone must use two-step sign-in and whether
sensitive actions ask for a fresh code; users may turn their own MFA off only where no rule requires it."""

import pyotp
import pytest
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.authorization import pdp
from apps.core.models import FeatureFlag
from apps.identity.models import MFADevice, MFARecoveryCode
from apps.identity.tests.test_auth_flows import enrol, login
from conftest import PASSWORD, ctx_for

pytestmark = [pytest.mark.django_db, pytest.mark.req("IAM-004")]
URL = "/api/v1/organization/security/"


@pytest.fixture
def admin(make_user, grant, org):
    user = make_user()
    grant(user, ["organization.organization.read", "organization.organization.update"], org)
    return user


def test_admin_requires_mfa_for_everyone(admin, make_user, org, api_for):
    staff = make_user()
    assert login(APIClient(), staff.email).json()["status"] == "authenticated"
    response = api_for(admin).patch(URL, {"require_mfa_for_all": True}, format="json")
    assert response.status_code == 200 and response.json()["require_mfa_for_all"] is True
    assert login(APIClient(), staff.email).json()["status"] == "mfa_enrollment_required"
    assert AuditEvent.objects.filter(action="organization.security_settings.updated").exists()


def test_relaxing_policy_needs_a_recent_code_when_the_admin_uses_mfa(admin, org, api_for):
    org.require_mfa_for_all = True
    org.save()
    enrol(admin)
    assert api_for(admin, mfa=False).patch(URL, {"require_mfa_for_all": False}, format="json").status_code == 403
    assert api_for(admin, mfa=True).patch(URL, {"require_mfa_for_all": False}, format="json").status_code == 200
    org.refresh_from_db()
    assert org.require_mfa_for_all is False


def test_sensitive_action_step_up_can_be_turned_off(make_user, grant, org, company):
    FeatureFlag.objects.create(key="module.finance", enabled_default=True)
    accountant = make_user()
    grant(accountant, ["finance.payment.post"], company)  # an MFA-marked permission
    resource = pdp.Resource.ref("finance.payment", company_id=company.pk)
    assert not pdp.can(ctx_for(accountant, company.pk, mfa=False), "finance.payment.post", resource)
    org.require_mfa_for_sensitive_actions = False
    org.save()
    accountant.refresh_from_db()
    assert pdp.can(ctx_for(accountant, company.pk, mfa=False), "finance.payment.post", resource)


def test_user_turns_own_mfa_off_only_when_allowed(make_user, api_for):
    user = make_user()
    secret = enrol(user)
    client = api_for(user)
    wrong = client.post("/api/v1/auth/mfa/disable/", {"password": PASSWORD, "code": "000000"}, format="json")
    assert wrong.status_code == 401 and MFADevice.objects.filter(user=user).exists()
    ok = client.post(
        "/api/v1/auth/mfa/disable/", {"password": PASSWORD, "code": pyotp.TOTP(secret).now()}, format="json"
    )
    assert ok.status_code == 204
    assert not MFADevice.objects.filter(user=user).exists() and not MFARecoveryCode.objects.filter(user=user).exists()
    assert login(APIClient(), user.email).json()["status"] == "authenticated"  # no code asked any more

    enforced = make_user(mfa_enforced=True)
    secret = enrol(enforced)
    refused = api_for(enforced).post(
        "/api/v1/auth/mfa/disable/", {"password": PASSWORD, "code": pyotp.TOTP(secret).now()}, format="json"
    )
    assert refused.status_code == 422 and refused.json()["code"] == "mfa_required_by_policy"


def test_platform_operators_always_need_mfa(db):
    from apps.identity.models import User
    from apps.identity.services import mfa_required_for

    operator = User.objects.create_user("ops@example.com", PASSWORD, full_name="Ops", is_platform_operator=True)
    assert mfa_required_for(operator)
