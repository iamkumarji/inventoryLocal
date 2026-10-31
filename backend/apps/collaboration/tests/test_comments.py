import uuid
from datetime import timedelta

import pytest
from django.db import DatabaseError, transaction
from django.utils import timezone

from apps.audit import services as audit
from apps.collaboration import records
from apps.collaboration.models import Comment, CommentRevision, Mention
from apps.notifications.models import Notification

pytestmark = pytest.mark.django_db

COMMENT_PERMS = ["collaboration.comment.create", "collaboration.comment.read", "collaboration.comment.update"]
URL = "/api/v1/collaboration/comments/"


@pytest.fixture
def author(make_user, grant, company):
    user = make_user("author@example.com", full_name="Asha Author")
    grant(user, [*COMMENT_PERMS, "organization.department.read"], company)
    return user


@pytest.fixture
def no_record_access(make_user, grant, company):
    """Holds the comment module permissions but cannot read the record."""
    user = make_user("blind@example.com")
    grant(user, COMMENT_PERMS, company)
    return user


def test_registry_discovers_models_by_resource_type():
    reg = records.registry()
    assert any(m.__name__ == "Department" for m in reg["organization.department"])
    assert "collaboration.comment" not in reg  # never a reference target


def test_comment_and_list_with_record_access(author, api_for, ref):
    client = api_for(author)
    created = client.post(URL, {**ref, "body": "Looks good"}, format="json")
    assert created.status_code == 201, created.content
    listed = client.get(URL, ref)
    assert listed.status_code == 200
    assert [c["body"] for c in listed.json()["results"]] == ["Looks good"]
    assert client.get(f"{URL}{created.json()['id']}/").status_code == 200


def test_no_record_access_is_404_everywhere(author, no_record_access, api_for, ref):
    comment_id = api_for(author).post(URL, {**ref, "body": "Internal note"}, format="json").json()["id"]
    client = api_for(no_record_access)
    assert client.get(URL, ref).status_code == 404
    assert client.post(URL, {**ref, "body": "hi"}, format="json").status_code == 404
    assert client.get(f"{URL}{comment_id}/").status_code == 404
    assert client.patch(f"{URL}{comment_id}/", {"body": "x", "version": 1}, format="json").status_code == 404
    assert client.get("/api/v1/collaboration/activity/", ref).status_code == 404
    assert Comment.objects.count() == 1


def test_unknown_type_missing_record_and_other_company_are_404(author, api_for, make_company, make_department):
    client = api_for(author)
    body = {"body": "hi"}
    assert (
        client.post(URL, {"resource_type": "nope.thing", "resource_id": str(uuid.uuid4()), **body}).status_code == 404
    )
    missing = {"resource_type": "organization.department", "resource_id": str(uuid.uuid4())}
    assert client.post(URL, {**missing, **body}, format="json").status_code == 404
    assert client.post(URL, {**missing, "resource_id": "not-a-uuid", **body}, format="json").status_code == 404
    foreign = make_department(make_company("C2"))
    other = {"resource_type": "organization.department", "resource_id": str(foreign.pk)}
    assert client.post(URL, {**other, **body}, format="json").status_code == 404


def test_user_without_comment_permission_is_denied(make_user, grant, company, api_for, ref):
    reader = make_user()
    grant(reader, ["organization.department.read"], company)
    assert api_for(reader).post(URL, {**ref, "body": "hi"}, format="json").status_code == 403


def test_mentions_notify_only_users_who_can_read_the_record(author, make_user, grant, company, api_for, ref):
    reader = make_user("reader@example.com")
    grant(reader, ["organization.department.read"], company)
    outsider = make_user("outsider@example.com")
    grant(outsider, ["collaboration.task.read"], company)
    body = f"Please check @reader@example.com and @[{outsider.pk}] and @ghost@example.com"
    response = api_for(author).post(URL, {**ref, "body": body}, format="json")
    assert response.status_code == 201
    assert response.json()["mentions"] == [str(reader.pk)]
    assert Notification.objects.filter(recipient=reader, category="task").count() == 1
    assert not Notification.objects.filter(recipient=outsider).exists()
    assert set(Mention.objects.values_list("user_id", flat=True)) == {reader.pk}


def test_edit_within_window_keeps_revisions_and_notifies_new_mentions(author, make_user, grant, company, api_for, ref):
    late = make_user("late@example.com")
    grant(late, ["organization.department.read"], company)
    client = api_for(author)
    comment = client.post(URL, {**ref, "body": "first"}, format="json").json()
    edited = client.patch(
        f"{URL}{comment['id']}/", {"body": "second @late@example.com", "version": comment["version"]}, format="json"
    )
    assert edited.status_code == 200, edited.content
    assert edited.json()["edited_at"] is not None
    assert list(CommentRevision.objects.values_list("body", flat=True)) == ["first"]
    assert Notification.objects.filter(recipient=late).count() == 1
    stale = client.patch(f"{URL}{comment['id']}/", {"body": "third", "version": comment["version"]}, format="json")
    assert stale.status_code == 409


def test_edit_window_and_author_only(author, make_user, grant, company, api_for, ref):
    colleague = make_user()
    grant(colleague, [*COMMENT_PERMS, "organization.department.read"], company)
    comment = api_for(author).post(URL, {**ref, "body": "mine"}, format="json").json()
    path = f"{URL}{comment['id']}/"
    assert api_for(colleague).patch(path, {"body": "theirs", "version": 1}, format="json").status_code == 403
    Comment.objects.filter(pk=comment["id"]).update(created_at=timezone.now() - timedelta(minutes=16))
    late = api_for(author).patch(path, {"body": "too late", "version": 1}, format="json")
    assert late.status_code == 422
    assert late.json()["code"] == "edit_window_closed"


def test_remove_is_soft_and_comments_cannot_be_hard_deleted(author, api_for, ref):
    client = api_for(author)
    comment = client.post(URL, {**ref, "body": "oops"}, format="json").json()
    removed = client.post(f"{URL}{comment['id']}/remove/", {"version": 1}, format="json")
    assert removed.status_code == 200
    assert removed.json()["is_removed"] is True
    assert removed.json()["body"] == ""
    assert Comment.objects.get(pk=comment["id"]).body == "oops"  # kept for the record
    with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
        Comment.objects.filter(pk=comment["id"]).delete()


def test_activity_merges_comments_and_audit_events(author, api_for, ref, record, system_ctx):
    audit.record(
        "organization.department.updated",
        ctx=system_ctx,
        resource_type="organization.department",
        resource_id=record.pk,
        summary="Renamed",
        changes={"name": {"from": "A", "to": "B"}},
    )
    client = api_for(author)
    client.post(URL, {**ref, "body": "Noted"}, format="json")
    response = client.get("/api/v1/collaboration/activity/", ref)
    assert response.status_code == 200
    kinds = {(e["kind"], e["action"]) for e in response.json()}
    assert ("comment", "collaboration.comment.created") in kinds
    assert ("audit", "organization.department.updated") in kinds
    assert all("changes" not in e for e in response.json())
