import pytest

from apps.audit.models import AuditEvent
from apps.identity.models import AuthSession, MFADevice, User

pytestmark = pytest.mark.django_db
USERS = "/api/v1/identity/users/"


@pytest.fixture
def admin(make_user, grant, org):
    user = make_user(email="admin@example.com")
    grant(
        user,
        [
            "identity.user.read",
            "identity.user.create",
            "identity.user.update",
            "identity.user.manage",
            "identity.auth_session.read",
        ],
        org,
    )
    return user


def test_admin_creates_user_with_temporary_password(admin, api_for, company):
    client = api_for(admin)
    response = client.post(
        USERS,
        {
            "email": "New.Person@Example.com",
            "full_name": "New Person",
            "default_company": str(company.pk),
            "temporary_password": "Temp-Passphrase-123",
        },
    )
    assert response.status_code == 201, response.json()
    created = User.objects.get(email="new.person@example.com")
    assert created.must_change_password and created.organization_id == admin.organization_id
    assert AuditEvent.objects.filter(action="identity.user.created", resource_id=str(created.pk)).exists()
    duplicate = client.post(
        USERS, {"email": "new.person@example.com", "full_name": "Dup", "temporary_password": "Temp-Passphrase-123"}
    )
    assert duplicate.status_code == 400


def test_user_list_requires_permission(make_user, api_for, admin):
    nobody = make_user()
    assert api_for(nobody).get(USERS).status_code == 403
    assert api_for(admin).get(USERS).json()["count"] >= 2


def test_manage_actions_require_step_up(admin, make_user, api_for):
    target = make_user()
    response = api_for(admin, mfa=False).post(f"{USERS}{target.pk}/deactivate/")
    assert response.status_code == 403 and response.json()["type"] == "mfa_required"


def test_deactivate_revokes_sessions_and_blocks_self(admin, make_user, api_for):
    target = make_user()
    target_client = api_for(target)
    client = api_for(admin)
    assert client.post(f"{USERS}{target.pk}/deactivate/").status_code == 200
    assert target_client.get("/api/v1/auth/me/").status_code == 401
    assert not AuthSession.objects.filter(user=target, revoked_at__isnull=True).exists()
    assert client.post(f"{USERS}{admin.pk}/deactivate/").json()["code"] == "self_deactivation"


def test_reset_mfa(admin, make_user, api_for):
    from django.utils import timezone

    target = make_user()
    MFADevice.objects.create(user=target, secret_encrypted="x", confirmed_at=timezone.now())
    assert api_for(admin).post(f"{USERS}{target.pk}/reset-mfa/").status_code == 200
    assert not MFADevice.objects.filter(user=target).exists()


def test_company_scoped_admin_sees_only_their_company_users(make_user, grant, api_for, make_company):
    c1, c2 = make_company("X1"), make_company("X2")
    local_admin = make_user(default_company=c1)
    grant(local_admin, ["identity.user.read"], c1)
    in_c1, in_c2 = make_user(default_company=c1), make_user(default_company=c2)
    ids = {u["id"] for u in api_for(local_admin).get(USERS).json()["results"]}
    assert str(in_c1.pk) in ids and str(in_c2.pk) not in ids
    assert api_for(local_admin).get(f"{USERS}{in_c2.pk}/").status_code == 404


def test_directory_is_minimal_and_org_scoped(make_user, api_for, make_company):
    from apps.organization.models import Organization

    me = make_user(full_name="Asha Rao")
    make_user(full_name="Ravi Kumar", email="ravi@example.com")
    make_user(full_name="Ravi Inactive", is_active=False)
    other_org = Organization.objects.create(code="OTHERORG", name="Other")
    make_user(full_name="Ravi Elsewhere", organization=other_org, default_company=None)
    client = api_for(me)
    assert client.get("/api/v1/identity/directory/?search=r").json() == []
    results = client.get("/api/v1/identity/directory/?search=ravi").json()
    assert [r["full_name"] for r in results] == ["Ravi Kumar"]
    assert set(results[0]) == {"id", "full_name", "email"}
