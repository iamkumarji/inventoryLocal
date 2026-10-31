import hashlib
import io
import zipfile
from datetime import datetime, timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.documents import storage
from apps.documents.models import Document, DocumentACL, DocumentVersion

pytestmark = pytest.mark.django_db
URL = "/api/v1/documents/documents/"
DOC_ALL = [f"documents.document.{v}" for v in ("create", "read", "update", "delete", "download", "share", "manage")]
PDF = b"%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@pytest.fixture(autouse=True)
def local_storage(settings, tmp_path):
    settings.DOCUMENTS_STORAGE = {
        "BACKEND": "apps.documents.storage.LocalFileStorage",
        "OPTIONS": {"root": str(tmp_path)},
    }
    return tmp_path


def pdf(name="spec.pdf", data=PDF, content_type="application/pdf"):
    return SimpleUploadedFile(name, data, content_type=content_type)


def xlsx_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/workbook.xml", "<workbook/>")
    return buf.getvalue()


@pytest.fixture
def owner(make_user, grant, company):
    user = make_user(full_name="Olga Owner")
    grant(user, [*DOC_ALL, "organization.department.read"], company)
    return user


@pytest.fixture
def reader(make_user, grant, company):
    user = make_user(full_name="Ravi Reader")
    grant(user, ["documents.document.read", "documents.document.download", "organization.department.read"], company)
    return user


def upload(client, **fields):
    data = {"title": "Spec", "file": pdf(), **fields}
    return client.post(URL, data, format="multipart")


def test_upload_creates_version_with_sha256(owner, api_for, ref, local_storage):
    response = upload(api_for(owner), **ref)
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["current_version"]["version_no"] == 1
    assert body["current_version"]["content_type"] == "application/pdf"
    assert body["current_version"]["sha256"] == hashlib.sha256(PDF).hexdigest()
    version = DocumentVersion.objects.get()
    assert (local_storage / version.object_key).read_bytes() == PDF


def test_versions_are_append_only(owner, api_for, local_storage):
    client = api_for(owner)
    doc = upload(client).json()
    second = client.post(
        f"{URL}{doc['id']}/versions/",
        {"file": pdf("spec-v2.pdf", PDF + b"% rev 2\n"), "version": 1},
        format="multipart",
    )
    assert second.status_code == 201, second.content
    assert second.json()["current_version"]["version_no"] == 2
    versions = client.get(f"{URL}{doc['id']}/versions/").json()
    assert [v["version_no"] for v in versions] == [2, 1]
    v1, v2 = DocumentVersion.objects.order_by("version_no")
    assert v1.object_key != v2.object_key
    assert (local_storage / v1.object_key).read_bytes() == PDF  # never overwritten
    stale = client.post(f"{URL}{doc['id']}/versions/", {"file": pdf(), "version": 1}, format="multipart")
    assert stale.status_code == 409
    with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
        DocumentVersion.objects.filter(pk=v1.pk).update(filename="evil.pdf")


@pytest.mark.parametrize(
    ("name", "data", "content_type", "code"),
    [
        ("tool.exe", b"MZ\x90\x00", "application/octet-stream", "unsupported_type"),
        ("image.pdf", PNG, "application/pdf", "content_mismatch"),
        ("spec.pdf", PDF, "image/png", "content_type_mismatch"),
        ("empty.txt", b"", "text/plain", "empty"),  # DRF FileField rejects it first
        ("binary.txt", b"abc\x00def", "text/plain", "content_mismatch"),
        ("latin1.csv", "café".encode("latin-1"), "text/csv", "content_mismatch"),
        ("fake.xlsx", b"PK\x03\x04garbage", XLSX, "content_mismatch"),
    ],
)
def test_content_type_validation(owner, api_for, name, data, content_type, code):
    response = upload(api_for(owner), file=SimpleUploadedFile(name, data, content_type=content_type))
    assert response.status_code == 400, response.content
    assert response.json()["errors"][0]["code"] == code
    assert not DocumentVersion.objects.exists()


@pytest.mark.parametrize(
    ("name", "data", "content_type"),
    [
        ("sheet.xlsx", xlsx_bytes(), XLSX),
        ("photo.jpg", b"\xff\xd8\xff\xe0" + b"\x00" * 32, "image/jpeg"),
        ("notes.txt", "naïve résumé".encode(), "text/plain"),
        ("data.csv", b"a,b\n1,2\n", "application/vnd.ms-excel"),
        ("pic.webp", b"RIFF\x24\x00\x00\x00WEBPVP8 ", "application/octet-stream"),
    ],
)
def test_allowed_types(owner, api_for, name, data, content_type):
    response = upload(api_for(owner), file=SimpleUploadedFile(name, data, content_type=content_type))
    assert response.status_code == 201, response.content


def test_size_limit(owner, api_for, settings):
    settings.DOCUMENTS_MAX_UPLOAD_BYTES = 32
    response = upload(api_for(owner), file=pdf(data=PDF + b"x" * 64))
    assert response.status_code == 400
    assert response.json()["errors"][0]["code"] == "file_too_large"


# --- Access ----------------------------------------------------------------------------------------


def test_record_access_is_delegated(owner, make_user, grant, company, api_for, ref):
    doc = upload(api_for(owner), **ref).json()
    blind = make_user()
    grant(blind, DOC_ALL, company)  # all document permissions, but cannot read the department
    client = api_for(blind)
    assert client.get(URL, ref).status_code == 404
    assert client.get(f"{URL}{doc['id']}/").status_code == 404
    assert client.post(f"{URL}{doc['id']}/download/", {}, format="json").status_code == 404
    assert client.post(URL, {"title": "x", "file": pdf(), **ref}, format="multipart").status_code == 404
    assert client.get(URL).json()["results"] == []  # linked documents never show in the library


def test_attachments_listing_for_record(owner, reader, api_for, ref):
    upload(api_for(owner), **ref)
    upload(api_for(owner), title="Library doc")
    attachments = api_for(reader).get(URL, ref).json()["results"]
    assert [d["title"] for d in attachments] == ["Spec"]
    assert [d["title"] for d in api_for(reader).get(URL).json()["results"]] == ["Library doc"]


def test_confidential_requires_explicit_acl(owner, reader, api_for, ref):
    doc = upload(api_for(owner), confidentiality="confidential", **ref).json()
    client = api_for(reader)
    assert client.get(f"{URL}{doc['id']}/").status_code == 404  # can read the record, but no ACL
    assert client.get(URL, ref).json()["results"] == []

    granted = api_for(owner).post(
        f"{URL}{doc['id']}/acl/", {"user": str(reader.pk), "permission": "read"}, format="json"
    )
    assert granted.status_code == 201, granted.content
    assert client.get(f"{URL}{doc['id']}/").status_code == 200
    assert [d["id"] for d in client.get(URL, ref).json()["results"]] == [doc["id"]]
    assert client.post(f"{URL}{doc['id']}/download/", {}, format="json").status_code == 200
    # A read ACL doesn't allow changes (and the reader lacks the update permission anyway).
    assert client.patch(f"{URL}{doc['id']}/", {"title": "x", "version": 1}, format="json").status_code == 403


def test_confidential_role_acl_and_write_level(owner, make_user, make_role, grant, company, api_for):
    editor_role = make_role([*DOC_ALL], code="doc_editor")
    editor = make_user()
    grant(editor, [], company, role=editor_role)
    doc = upload(api_for(owner), confidentiality="confidential").json()
    client = api_for(editor)
    assert client.get(f"{URL}{doc['id']}/").status_code == 404
    api_for(owner).post(f"{URL}{doc['id']}/acl/", {"role": str(editor_role.pk), "permission": "read"}, format="json")
    assert client.patch(f"{URL}{doc['id']}/", {"title": "x", "version": 1}, format="json").status_code == 403
    api_for(owner).post(f"{URL}{doc['id']}/acl/", {"role": str(editor_role.pk), "permission": "write"}, format="json")
    assert client.patch(f"{URL}{doc['id']}/", {"title": "Renamed", "version": 1}, format="json").status_code == 200
    owner_acl = DocumentACL.objects.get(user=owner)
    role_acl = DocumentACL.objects.get(role=editor_role)
    assert api_for(owner).delete(f"{URL}{doc['id']}/acl/{role_acl.pk}/").status_code == 204
    last = api_for(owner).delete(f"{URL}{doc['id']}/acl/{owner_acl.pk}/")
    assert last.status_code == 422  # the last writer of a confidential document stays


def test_restricted_library_document_is_need_to_know(owner, reader, api_for):
    doc = upload(api_for(owner), confidentiality="restricted").json()
    assert api_for(owner).get(f"{URL}{doc['id']}/").status_code == 200
    assert api_for(reader).get(f"{URL}{doc['id']}/").status_code == 404
    assert api_for(reader).get(URL).json()["results"] == []


def test_declassification_requires_manage(make_user, grant, company, api_for):
    author = make_user()
    grant(author, ["documents.document.create", "documents.document.read", "documents.document.update"], company)
    client = api_for(author)
    doc = upload(client, confidentiality="confidential").json()
    assert (
        client.patch(f"{URL}{doc['id']}/", {"confidentiality": "internal", "version": 1}, format="json").status_code
        == 403
    )


# --- Downloads -------------------------------------------------------------------------------------


def test_download_url_is_short_lived_bound_and_audited(owner, reader, api_for, ref):
    doc = upload(api_for(owner), **ref).json()
    issued = api_for(reader).post(f"{URL}{doc['id']}/download/", {}, format="json")
    assert issued.status_code == 200, issued.content
    body = issued.json()
    assert body["sha256"] == doc["current_version"]["sha256"]
    expires = datetime.fromisoformat(body["expires_at"])
    assert expires <= timezone.now() + timedelta(minutes=5, seconds=1)
    event = AuditEvent.objects.get(action="documents.document.downloaded")
    assert event.actor_id == reader.pk
    assert event.resource_id == doc["id"]

    served = api_for(reader).get(body["url"])
    assert served.status_code == 200
    assert b"".join(served.streaming_content) == PDF
    assert served["Content-Type"] == "application/pdf"
    assert served["X-Content-Type-Options"] == "nosniff"
    assert "attachment" in served["Content-Disposition"]

    assert api_for(owner).get(body["url"]).status_code == 403  # bound to the requesting user
    assert APIClient().get(body["url"]).status_code == 401


def test_invalid_and_expired_tokens_are_rejected(owner, api_for, ref):
    doc = upload(api_for(owner), **ref).json()
    url = api_for(owner).post(f"{URL}{doc['id']}/download/", {}, format="json").json()["url"]
    token = url.rstrip("/").rsplit("/", 1)[1]
    encoded, signature = token.split(".")
    client = api_for(owner)
    tampered = f"{encoded}.{'0' * len(signature)}"
    assert client.get(url.replace(token, tampered)).status_code == 403
    assert client.get(url.replace(token, "garbage")).status_code == 403

    backend = storage.get_storage()
    key = DocumentVersion.objects.get().object_key
    expired = backend.make_token(key, subject_id=str(owner.pk), expires_in=-1)
    response = client.get(f"/api/v1/documents/files/{expired}/")
    assert response.status_code == 403
    assert response.json()["code"] == "download_link_expired"
    other_key = backend.make_token("x/y/z", subject_id=str(owner.pk), expires_in=60)
    assert client.get(f"/api/v1/documents/files/{other_key}/").status_code == 403


def test_download_rechecks_access_when_served(owner, reader, api_for, ref):
    doc = upload(api_for(owner), confidentiality="confidential", **ref).json()
    acl = api_for(owner).post(f"{URL}{doc['id']}/acl/", {"user": str(reader.pk), "permission": "read"}, format="json")
    url = api_for(reader).post(f"{URL}{doc['id']}/download/", {}, format="json").json()["url"]
    api_for(owner).delete(f"{URL}{doc['id']}/acl/{acl.json()['id']}/")
    assert api_for(reader).get(url).status_code == 404


# --- Retention and legal hold ----------------------------------------------------------------------


def test_legal_hold_and_retention_block_deletion(owner, api_for, local_storage, django_capture_on_commit_callbacks):
    client = api_for(owner)
    doc = upload(client, retention_until=str(timezone.localdate() + timedelta(days=30))).json()
    path = f"{URL}{doc['id']}/"
    early = client.delete(path)
    assert early.status_code == 422
    assert early.json()["code"] == "retention_period"

    past = client.post(
        f"{path}retention/",
        {"retention_until": str(timezone.localdate() - timedelta(days=1)), "version": 1},
        format="json",
    )
    assert past.status_code == 200, past.content
    held = client.post(
        f"{path}legal-hold/", {"legal_hold": True, "reason": "Litigation 42", "version": 2}, format="json"
    )
    assert held.json()["legal_hold"] is True
    blocked = client.delete(path)
    assert blocked.status_code == 422
    assert blocked.json()["code"] == "legal_hold"

    client.post(f"{path}legal-hold/", {"legal_hold": False, "version": 3}, format="json")
    key = DocumentVersion.objects.get().object_key
    with django_capture_on_commit_callbacks(execute=True):
        assert client.delete(path).status_code == 204
    assert not DocumentVersion.objects.exists()
    assert not (local_storage / key).exists()
    assert AuditEvent.objects.filter(action="documents.document.deleted", resource_id=doc["id"]).exists()


def test_legal_hold_requires_manage(reader, owner, api_for):
    doc = upload(api_for(owner)).json()
    response = api_for(reader).post(
        f"{URL}{doc['id']}/legal-hold/", {"legal_hold": True, "reason": "x", "version": 1}, format="json"
    )
    assert response.status_code == 403


def test_comments_on_confidential_document_follow_its_acl(owner, reader, make_user, grant, company, api_for):
    grant(reader, ["collaboration.comment.create", "collaboration.comment.read"], company)
    doc = upload(api_for(owner), confidentiality="confidential").json()
    ref = {"resource_type": "documents.document", "resource_id": doc["id"]}
    assert api_for(reader).get("/api/v1/collaboration/comments/", ref).status_code == 404


@pytest.mark.req("NFR-010")
def test_mobile_upload_replay_does_not_duplicate(owner, api_for):
    """An offline queue resends an upload whose response was lost: same key, one document."""
    client = api_for(owner)
    first = client.post(URL, {"title": "POD photo", "file": pdf()}, format="multipart", HTTP_IDEMPOTENCY_KEY="pod-1")
    again = client.post(URL, {"title": "POD photo", "file": pdf()}, format="multipart", HTTP_IDEMPOTENCY_KEY="pod-1")
    assert first.status_code == again.status_code == 201
    assert again["Idempotent-Replayed"] == "true" and again.json()["id"] == first.json()["id"]
    assert Document.objects.filter(title="POD photo").count() == 1


def test_access_list_and_versions_name_people(owner, reader, api_for, ref):
    # The document screen lists grants and uploads by person; ids alone showed "A colleague".
    client = api_for(owner)
    doc = upload(client, confidentiality="confidential", **ref).json()
    assert doc["current_version"]["uploaded_by_name"] == owner.full_name
    client.post(f"{URL}{doc['id']}/acl/", {"user": str(reader.pk), "permission": "read"}, format="json")
    entries = client.get(f"{URL}{doc['id']}/acl/").json()
    assert (str(reader.pk), reader.full_name, None) in [(e["user"], e["user_name"], e["role_name"]) for e in entries]
    versions = client.get(f"{URL}{doc['id']}/versions/").json()
    assert versions[0]["uploaded_by_name"] == owner.full_name


def test_attachment_is_authorized_at_the_records_scope(make_user, grant, record, ref, company, api_for):
    """Someone granted only on a record's unit (a driver on a branch, here a department) can attach to
    that record, but can't create standalone company documents."""
    clerk = make_user()
    grant(clerk, ["documents.document.create", "documents.document.read", "organization.department.read"], record)
    client = api_for(clerk, company=company)
    assert upload(client, **ref).status_code == 201
    assert upload(client).status_code == 403
