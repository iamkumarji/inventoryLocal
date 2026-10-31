import uuid
from datetime import timedelta

import pytest
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.test import APIRequestFactory, force_authenticate
from rest_framework.views import APIView

from apps.core import flags
from apps.core.exceptions import BusinessRuleViolation
from apps.core.idempotency import idempotent
from apps.core.ids import uuid7, uuid7_timestamp_ms
from apps.core.models import FeatureFlag, IdempotencyKey, InboxReceipt, OutboxEvent
from apps.core.outbox import _handlers, publish_event, register_handler, relay_batch

# --- UUIDv7 ------------------------------------------------------------------------------


def test_uuid7_layout_and_ordering():
    values = [uuid7() for _ in range(200)]
    assert all(v.version == 7 and v.variant == uuid.RFC_4122 for v in values)
    assert len(set(values)) == 200
    stamps = [uuid7_timestamp_ms(v) for v in values]
    assert stamps == sorted(stamps)
    assert abs(stamps[-1] - int(timezone.now().timestamp() * 1000)) < 5000


# --- Idempotency --------------------------------------------------------------------------


class _Body(serializers.Serializer):
    key = serializers.CharField()


class IdempotentCreateView(APIView):
    authz_authenticated_only = True

    @idempotent(required=True)
    def post(self, request):
        body = _Body(data=request.data)
        body.is_valid(raise_exception=True)
        if body.validated_data["key"] == "explode":
            raise BusinessRuleViolation("nope", code="nope")
        flag = FeatureFlag.objects.create(key=body.validated_data["key"])
        return Response({"id": str(flag.pk)}, status=201)


def _post(user, data, key="k-1"):
    factory = APIRequestFactory()
    headers = {"HTTP_IDEMPOTENCY_KEY": key} if key else {}
    request = factory.post("/test/", data, format="json", **headers)
    force_authenticate(request, user=user)
    return IdempotentCreateView.as_view()(request)


@pytest.mark.django_db
@pytest.mark.req("FND-005")
def test_idempotent_replay_returns_stored_response(make_user):
    user = make_user()
    first = _post(user, {"key": "flag.a"})
    second = _post(user, {"key": "flag.a"})
    assert first.status_code == second.status_code == 201
    assert first.data == second.data
    assert second["Idempotent-Replayed"] == "true"
    assert FeatureFlag.objects.filter(key="flag.a").count() == 1


@pytest.mark.django_db
def test_idempotency_key_reuse_with_different_payload(make_user):
    user = make_user()
    _post(user, {"key": "flag.b"})
    response = _post(user, {"key": "flag.other"})
    assert response.status_code == 422 and response.data["type"] == "idempotency_key_reused"


@pytest.mark.django_db
def test_idempotency_required_and_failures_release_key(make_user):
    user = make_user()
    assert _post(user, {"key": "x"}, key=None).status_code == 400
    failed = _post(user, {"key": "explode"}, key="k-fail")
    assert failed.status_code == 422
    assert not IdempotencyKey.objects.filter(key="k-fail").exists()  # client may retry


@pytest.mark.django_db
def test_idempotency_in_progress_conflict(make_user):
    user = make_user()
    IdempotencyKey.objects.create(
        user=user,
        key="busy",
        method="POST",
        path="/test/",
        request_hash=_fingerprint_for({"key": "flag.c"}),
        expires_at=timezone.now() + timedelta(hours=1),
    )
    response = _post(user, {"key": "flag.c"}, key="busy")
    assert response.status_code == 409 and response.data["type"] == "idempotency_in_progress"


def _fingerprint_for(data):
    import hashlib
    import json

    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"POST\n/test/\n{canonical}".encode()).hexdigest()


@pytest.mark.django_db
def test_idempotency_keys_are_per_user(make_user):
    a, b = make_user(), make_user()
    _post(a, {"key": "flag.d"}, key="shared")
    response = _post(b, {"key": "flag.e"}, key="shared")
    assert response.status_code == 201


# --- Outbox ---------------------------------------------------------------------------------


@pytest.fixture
def clean_handlers():
    saved = {k: list(v) for k, v in _handlers.items()}
    yield
    _handlers.clear()
    _handlers.update(saved)


@pytest.mark.django_db(transaction=True)
def test_publish_requires_transaction():
    with pytest.raises(RuntimeError):
        publish_event("test.happened", aggregate_type="test", aggregate_id=uuid7())


@pytest.mark.django_db
@pytest.mark.req("FND-006")
def test_relay_runs_handlers_once(clean_handlers):
    seen = []

    @register_handler("test.happened", name="collector")
    def collector(event):
        seen.append(event.aggregate_id)

    with transaction.atomic():
        event = publish_event("test.happened", aggregate_type="test", aggregate_id=uuid7(), payload={"n": 1})
    assert relay_batch() == 1
    event.refresh_from_db()
    assert event.status == "published" and seen == [event.aggregate_id]
    assert InboxReceipt.objects.filter(event=event, handler="collector").count() == 1
    assert relay_batch() == 0


@pytest.mark.django_db
def test_failed_handler_backs_off_and_dead_letters(clean_handlers, settings):
    settings.ERP = {**settings.ERP, "OUTBOX_MAX_ATTEMPTS": 2}
    calls = {"ok": 0}

    @register_handler("test.flaky", name="ok_first")
    def ok_first(event):
        calls["ok"] += 1

    @register_handler("test.flaky", name="always_fails")
    def always_fails(event):
        raise ValueError("downstream unavailable")

    with transaction.atomic():
        event = publish_event("test.flaky", aggregate_type="test", aggregate_id=uuid7())
    relay_batch()
    event.refresh_from_db()
    assert event.status == "failed" and event.attempts == 1 and "downstream" in event.last_error
    assert event.next_attempt_at > timezone.now()
    OutboxEvent.objects.filter(pk=event.pk).update(next_attempt_at=timezone.now())
    relay_batch()
    event.refresh_from_db()
    assert event.status == "dead"
    assert calls["ok"] == 1  # successful handler is not re-run on retry


# --- Feature flags ----------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.req("FND-004")
def test_flag_precedence_and_unknown_flags():
    user_id, company_id = uuid7(), uuid7()
    FeatureFlag.objects.create(
        key="module.x",
        enabled_default=False,
        rules={"companies": {str(company_id): True}, "roles": {"tester": False}, "users": {str(user_id): True}},
    )
    flags.invalidate()
    assert flags.is_enabled("module.unknown") is False
    assert flags.is_enabled("module.x") is False
    assert flags.is_enabled("module.x", company_id=company_id) is True
    assert flags.is_enabled("module.x", company_id=company_id, role_codes=["tester"]) is False
    assert flags.is_enabled("module.x", user_id=user_id, role_codes=["tester"]) is True


# --- Database guards ----------------------------------------------------------------------------


@pytest.mark.django_db
def test_posted_mutation_trigger_freezes_posted_rows():
    with connection.cursor() as cur:
        cur.execute("CREATE TEMP TABLE t_doc (id int primary key, status text, amount numeric, reversed_by text)")
        cur.execute(
            "CREATE TRIGGER t_doc_guard BEFORE UPDATE OR DELETE ON t_doc FOR EACH ROW EXECUTE FUNCTION "
            "erp_forbid_posted_mutation('status', 'posted', 'reversed_by')"
        )
        cur.execute("INSERT INTO t_doc VALUES (1, 'draft', 10, NULL)")
        cur.execute("UPDATE t_doc SET amount = 11 WHERE id = 1")  # draft: editable
        cur.execute("UPDATE t_doc SET status = 'posted' WHERE id = 1")  # transition allowed
        cur.execute("UPDATE t_doc SET reversed_by = 'REV-1' WHERE id = 1")  # whitelisted column
        for statement in (
            "UPDATE t_doc SET amount = 12 WHERE id = 1",
            "DELETE FROM t_doc WHERE id = 1",
            "UPDATE t_doc SET status = 'draft' WHERE id = 1",
        ):
            with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
                cur.execute(statement)


@pytest.mark.django_db
def test_unique_constraints_on_platform_tables(make_user):
    user = make_user()
    IdempotencyKey.objects.create(
        user=user, key="dup", method="POST", path="/", request_hash="h", expires_at=timezone.now()
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        IdempotencyKey.objects.create(
            user=user, key="dup", method="POST", path="/", request_hash="h", expires_at=timezone.now()
        )


# --- Error contract -------------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.req("FND-007")
def test_error_shape_and_request_id(api_for, make_user):
    client = api_for(make_user())
    response = client.post(
        "/api/v1/auth/password/change/", {"current_password": "x"}, HTTP_X_REQUEST_ID="req-abc-12345"
    )
    body = response.json()
    assert response.status_code == 400
    assert body["type"] == "validation_error" and body["status"] == 400
    assert body["errors"] == [{"field": "new_password", "code": "required", "message": "This field is required."}]
    assert response["X-Request-ID"] == "req-abc-12345" == body["request_id"]
    not_auth = api_for(make_user()).__class__().get("/api/v1/auth/me/")
    assert not_auth.status_code == 401 and not_auth.json()["type"] == "not_authenticated"
    assert "Bearer" in not_auth["WWW-Authenticate"]
