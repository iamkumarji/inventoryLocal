import pytest
from django.db import DatabaseError, connection, transaction

from apps.audit import services
from apps.audit.models import AuditChainSeal, AuditEvent

pytestmark = pytest.mark.django_db


def _events(n, ctx):
    return [
        services.record(
            f"test.event.{i}",
            ctx=ctx,
            resource_type="test",
            resource_id=i,
            changes={"amount": {"from": "1.0000", "to": "2.5000"}},
        )
        for i in range(n)
    ]


@pytest.mark.req("AUD-001")
def test_audit_events_are_append_only(system_ctx):
    event = services.record("test.created", ctx=system_ctx, summary="hello")
    with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
        AuditEvent.objects.filter(pk=event.pk).update(summary="tampered")
    with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
        AuditEvent.objects.filter(pk=event.pk).delete()


@pytest.mark.req("AUD-002")
def test_seal_and_verify_chain(system_ctx):
    _events(5, system_ctx)
    assert services.seal_pending() == 5
    assert services.seal_pending() == 0
    _events(2, system_ctx)
    assert services.seal_pending() == 2
    result = services.verify_chain()
    assert result == {"valid": True, "checked": 7, "head": AuditChainSeal.objects.get(seq=7).chain_hash, "unsealed": 0}


@pytest.mark.req("AUD-002")
def test_tampering_is_detected_even_if_trigger_is_bypassed(system_ctx):
    events = _events(3, system_ctx)
    services.seal_pending()
    with connection.cursor() as cur:  # simulates a privileged attacker disabling the guard
        cur.execute("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only")
        cur.execute("UPDATE audit_events SET summary = 'rewritten' WHERE id = %s", [events[1].pk])
        cur.execute("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only")
    result = services.verify_chain()
    assert result["valid"] is False and result["problem"] == "event_modified" and result["seq"] == 2


def test_diff_masks_sensitive_fields():
    changes = services.diff({"name": "a", "salary": "100"}, {"name": "b", "salary": "200"}, sensitive=["salary"])
    assert changes == {"name": {"from": "a", "to": "b"}, "salary": {"from": "***", "to": "***"}}


def test_audit_api_is_read_only_and_scoped(make_user, grant, api_for, org, make_company, system_ctx):
    c1, c2 = make_company("A1"), make_company("A2")
    services.record("x.in_c1", ctx=system_ctx, company_id=c1.pk, organization_id=org.pk)
    services.record("x.in_c2", ctx=system_ctx, company_id=c2.pk, organization_id=org.pk)
    auditor = make_user(default_company=c1)
    grant(auditor, ["audit.audit_event.read"], c1)
    client = api_for(auditor)
    actions = {e["action"] for e in client.get("/api/v1/audit/events/").json()["results"]}
    assert "x.in_c1" in actions and "x.in_c2" not in actions
    assert client.post("/api/v1/audit/events/", {}, format="json").status_code == 405
    assert client.get("/api/v1/audit/events/verify-chain/").status_code == 403  # needs audit.audit_event.manage
