import pytest
from django.core import mail

from apps.notifications import services
from apps.notifications.models import Notification

pytestmark = pytest.mark.django_db


def test_notify_dedupes_and_skips_inactive(make_user, django_capture_on_commit_callbacks):
    active, inactive = make_user(), make_user(is_active=False)
    with django_capture_on_commit_callbacks(execute=True):
        services.notify([active, inactive, active], category="system", title="Hello", dedupe_key="k1")
        services.notify([active], category="system", title="Hello again", dedupe_key="k1")
    assert Notification.objects.filter(recipient=active).count() == 1
    assert not Notification.objects.filter(recipient=inactive).exists()
    assert len(mail.outbox) == 1 and mail.outbox[0].to == [active.email]  # Celery eager in tests


def test_preferences_respect_mandatory_channels(make_user, django_capture_on_commit_callbacks):
    user = make_user()
    services.set_preferences(
        user,
        [
            {"category": "system", "channel": "in_app", "enabled": False},
            {"category": "approval", "channel": "in_app", "enabled": False},  # mandatory: ignored
            {"category": "approval", "channel": "email", "enabled": False},
        ],
    )
    with django_capture_on_commit_callbacks(execute=True):
        services.notify([user], category="system", title="Muted")
        services.notify([user], category="approval", title="Must arrive")
    assert list(Notification.objects.filter(recipient=user).values_list("title", flat=True)) == ["Must arrive"]
    assert mail.outbox == []
    prefs = {(p["category"], p["channel"]): p for p in services.effective_preferences(user)}
    assert prefs[("approval", "in_app")]["mandatory"] and prefs[("approval", "in_app")]["enabled"]


def test_api_list_count_and_mark_read(make_user, api_for):
    user, other = make_user(), make_user()
    services.notify([user], category="system", title="A")
    services.notify([user], category="system", title="B")
    services.notify([other], category="system", title="Not yours")
    client = api_for(user)
    listing = client.get("/api/v1/notifications/").json()["results"]
    assert {n["title"] for n in listing} == {"A", "B"}
    assert client.get("/api/v1/notifications/unread-count/").json() == {"unread_count": 2}
    first = listing[0]["id"]
    assert client.post("/api/v1/notifications/mark-read/", {"ids": [first]}, format="json").json() == {
        "unread_count": 1
    }
    assert client.post("/api/v1/notifications/mark-read/", {}, format="json").json() == {"unread_count": 0}
    other_id = Notification.objects.get(recipient=other).pk
    client.post("/api/v1/notifications/mark-read/", {"ids": [str(other_id)]}, format="json")
    assert Notification.objects.get(pk=other_id).read_at is None  # can't touch someone else's


def test_api_preferences(make_user, api_for):
    client = api_for(make_user())
    prefs = client.get("/api/v1/notifications/preferences/").json()
    assert len(prefs) == 12
    updated = client.put(
        "/api/v1/notifications/preferences/",
        [{"category": "task", "channel": "email", "enabled": False}],
        format="json",
    ).json()
    assert next(p for p in updated if p["category"] == "task" and p["channel"] == "email")["enabled"] is False
