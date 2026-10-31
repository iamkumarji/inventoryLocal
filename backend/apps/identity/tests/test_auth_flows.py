from datetime import timedelta

import pyotp
import pytest
import time_machine
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.identity import mfa, services
from apps.identity.models import AuthSession, MFADevice, User
from conftest import PASSWORD

pytestmark = pytest.mark.django_db
LOGIN = "/api/v1/auth/login/"


def login(client, email, password=PASSWORD, client_type="web"):
    return client.post(LOGIN, {"email": email, "password": password, "client_type": client_type}, format="json")


def enrol(user) -> str:
    secret = mfa.new_secret()
    MFADevice.objects.create(user=user, secret_encrypted=mfa.encrypt_secret(secret), confirmed_at=timezone.now())
    return secret


@pytest.mark.req("IAM-001")
def test_web_login_sets_httponly_cookie_and_csrf(make_user):
    user = make_user()
    client = APIClient()
    response = login(client, user.email.upper())  # email is case-insensitive
    assert response.status_code == 200, response.json()
    assert response.json()["status"] == "authenticated"
    assert "token" not in response.json()  # web never receives the raw token in the body
    cookie = response.cookies["erp_session"]
    assert cookie["httponly"] and cookie["samesite"] == "Lax"
    assert response.cookies["erp_csrf"].value == response.json()["csrf_token"]
    assert AuditEvent.objects.filter(action="auth.login.success", actor_id=user.pk).exists()

    me = client.get("/api/v1/auth/me/")
    assert me.status_code == 200 and me.json()["user"]["email"] == user.email


def test_cookie_session_requires_csrf_for_unsafe_methods(make_user):
    user = make_user()
    client = APIClient()
    csrf = login(client, user.email).json()["csrf_token"]
    assert client.post("/api/v1/auth/logout/").status_code == 403
    assert client.post("/api/v1/auth/logout/", HTTP_X_CSRF_TOKEN="wrong").status_code == 403
    assert client.post("/api/v1/auth/logout/", HTTP_X_CSRF_TOKEN=csrf).status_code == 204
    assert client.get("/api/v1/auth/me/").status_code == 401  # revoked


def test_mobile_login_returns_bearer_token(make_user):
    user = make_user()
    body = login(APIClient(), user.email, client_type="mobile").json()
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {body['token']}")
    assert client.get("/api/v1/auth/me/").status_code == 200
    assert AuthSession.objects.get(user=user).token_hash != body["token"]  # only the hash is stored


def test_bad_credentials_are_generic_and_audited(make_user):
    user = make_user()
    wrong = login(APIClient(), user.email, "nope-nope-nope")
    unknown = login(APIClient(), "ghost@example.com", "nope-nope-nope")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["type"] == unknown.json()["type"] == "authentication_failed"
    assert AuditEvent.objects.filter(action="auth.login.failure", outcome="failure").count() == 2


@pytest.mark.req("IAM-004")
def test_lockout_after_threshold(make_user, settings):
    user = make_user()
    for _ in range(settings.ERP["LOCKOUT_THRESHOLD"]):
        assert login(APIClient(), user.email, "bad-password-xx").status_code == 401
    locked = login(APIClient(), user.email)  # correct password, still locked
    assert locked.status_code == 403 and locked.json()["type"] == "account_locked"
    assert AuditEvent.objects.filter(action="auth.account.locked", actor_id=user.pk).exists()
    with time_machine.travel(timezone.now() + timedelta(minutes=settings.ERP["LOCKOUT_MINUTES"] + 1)):
        assert login(APIClient(), user.email).status_code == 200


@pytest.mark.req("IAM-002")
def test_mfa_login_flow_and_replay_protection(make_user):
    user = make_user()
    secret = enrol(user)
    client = APIClient()
    first = login(client, user.email).json()
    assert first["status"] == "mfa_required" and "challenge_token" in first
    assert "erp_session" not in client.cookies or not client.cookies["erp_session"].value

    code = pyotp.TOTP(secret).now()
    ok = client.post("/api/v1/auth/login/mfa/", {"challenge_token": first["challenge_token"], "code": code})
    assert ok.status_code == 200 and ok.json()["status"] == "authenticated"
    assert AuthSession.objects.get(user=user).mfa_verified_at is not None

    # Same TOTP code cannot be replayed for a new challenge.
    second = login(APIClient(), user.email).json()
    replay = APIClient().post("/api/v1/auth/login/mfa/", {"challenge_token": second["challenge_token"], "code": code})
    assert replay.status_code == 401


def test_mfa_challenge_attempt_limit(make_user, settings):
    user = make_user()
    enrol(user)
    token = login(APIClient(), user.email).json()["challenge_token"]
    for _ in range(settings.ERP["MFA_CHALLENGE_MAX_ATTEMPTS"]):
        APIClient().post("/api/v1/auth/login/mfa/", {"challenge_token": token, "code": "000000"})
    secret_code = "123456"
    response = APIClient().post("/api/v1/auth/login/mfa/", {"challenge_token": token, "code": secret_code})
    assert response.status_code == 401 and "expired" in response.json()["detail"]


def test_recovery_code_is_single_use(make_user):
    user = make_user()
    enrol(user)
    codes = services._replace_recovery_codes(user)
    for expected in (200, 401):
        token = login(APIClient(), user.email).json()["challenge_token"]
        response = APIClient().post("/api/v1/auth/login/mfa/", {"challenge_token": token, "code": codes[0].lower()})
        assert response.status_code == expected


@pytest.mark.req("IAM-002")
def test_enforced_mfa_restricts_session_until_enrolled(make_user, company, grant):
    user = make_user(mfa_enforced=True)
    grant(user, ["organization.company.read"], company)
    client = APIClient()
    body = login(client, user.email, client_type="mobile").json()
    assert body["status"] == "mfa_enrollment_required"
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {body['token']}")

    blocked = client.get("/api/v1/organization/companies/")
    assert blocked.status_code == 403 and blocked.json()["type"] == "mfa_enrollment_required"
    me = client.get("/api/v1/auth/me/").json()
    assert me["session"]["restricted_reason"] == "mfa_enrollment" and me["permissions"]["codes"] == []

    setup = client.post("/api/v1/auth/mfa/totp/setup/").json()
    assert setup["otpauth_uri"].startswith("otpauth://totp/")
    confirm = client.post("/api/v1/auth/mfa/totp/confirm/", {"code": pyotp.TOTP(setup["secret"]).now()})
    assert confirm.status_code == 200 and len(confirm.json()["recovery_codes"]) == 10
    assert client.get("/api/v1/organization/companies/").status_code == 200
    # Re-enrolment needs an administrator reset.
    assert client.post("/api/v1/auth/mfa/totp/setup/").json()["code"] == "mfa_already_enrolled"


def test_must_change_password_restriction(make_user):
    user = make_user(must_change_password=True)
    client = APIClient()
    body = login(client, user.email, client_type="mobile").json()
    assert body["status"] == "password_change_required"
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {body['token']}")
    assert client.get("/api/v1/auth/sessions/").json()["type"] == "password_change_required"
    changed = client.post(
        "/api/v1/auth/password/change/", {"current_password": PASSWORD, "new_password": "A-brand-new-Passphrase-42"}
    )
    assert changed.status_code == 204
    assert client.get("/api/v1/auth/sessions/").status_code == 200


@pytest.mark.req("IAM-003")
def test_idle_and_absolute_expiry(make_user, settings):
    user = make_user()
    info = services.ClientInfo(client_type="web")
    _, token = services.create_session(user, info, mfa_verified=False)
    assert services.authenticate_token(token) is not None
    idle = settings.ERP["SESSION_IDLE_MINUTES"]
    with time_machine.travel(timezone.now() + timedelta(minutes=idle + 1)):
        assert services.authenticate_token(token) is None
    # Activity extends idle expiry but never beyond the absolute lifetime.
    _, token2 = services.create_session(user, info, mfa_verified=False)
    start = timezone.now()
    absolute = timedelta(hours=settings.ERP["SESSION_ABSOLUTE_HOURS"])
    step = timedelta(minutes=idle - 5)
    t = start
    while t + step < start + absolute:
        t += step
        with time_machine.travel(t):
            assert services.authenticate_token(token2) is not None
    with time_machine.travel(start + absolute + timedelta(seconds=1)):
        assert services.authenticate_token(token2) is None


def test_role_max_session_minutes_caps_lifetime(make_user, company, grant):
    user = make_user()
    a = grant(user, ["organization.company.read"], company)
    a.role.max_session_minutes = 30
    a.role.save()
    session, _ = services.create_session(user, services.ClientInfo(), mfa_verified=True)
    assert (session.absolute_expires_at - session.created_at) <= timedelta(minutes=30, seconds=5)


def test_password_change_policy_and_history(make_user, api_for):
    user = make_user()
    client = api_for(user)
    other = api_for(user)
    url = "/api/v1/auth/password/change/"
    weak = client.post(url, {"current_password": PASSWORD, "new_password": "short"})
    assert weak.status_code == 400 and weak.json()["errors"][0]["field"] == "new_password"
    assert client.post(url, {"current_password": PASSWORD, "new_password": "Second-Passphrase-77"}).status_code == 204
    assert other.get("/api/v1/auth/me/").status_code == 401  # other sessions revoked
    reuse = client.post(url, {"current_password": "Second-Passphrase-77", "new_password": PASSWORD})
    assert reuse.status_code == 400 and "recently" in reuse.json()["errors"][0]["message"]


def test_step_up_refreshes_mfa_timestamp(make_user, api_for):
    user = make_user()
    secret = enrol(user)
    client = api_for(user, mfa=False)
    assert client.post("/api/v1/auth/step-up/", {"code": "000000"}).status_code == 401
    ok = client.post("/api/v1/auth/step-up/", {"code": pyotp.TOTP(secret).now()})
    assert ok.status_code == 200
    client.session_obj.refresh_from_db()
    assert client.session_obj.mfa_verified_at is not None


def test_list_and_revoke_own_sessions(make_user, api_for):
    user = make_user()
    a, b = api_for(user), api_for(user)
    sessions = a.get("/api/v1/auth/sessions/").json()
    assert len(sessions) == 2 and sum(s["is_current"] for s in sessions) == 1
    assert a.delete(f"/api/v1/auth/sessions/{b.session_obj.pk}/").status_code == 204
    assert b.get("/api/v1/auth/me/").status_code == 401
    intruder = api_for(make_user())
    assert intruder.delete(f"/api/v1/auth/sessions/{a.session_obj.pk}/").status_code == 404


def test_superuser_must_use_mfa(org, company):
    admin = User.objects.create_superuser("root@example.com", PASSWORD, full_name="Root", organization=org)
    body = login(APIClient(), admin.email).json()
    assert body["status"] == "mfa_enrollment_required"
