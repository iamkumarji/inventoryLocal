import hashlib
import hmac
import json
from types import SimpleNamespace

import pytest
from django.db import transaction
from rest_framework.exceptions import ValidationError

from apps.core.models import FeatureFlag
from apps.core.outbox import publish_event, relay_batch
from apps.integrations import services
from apps.integrations.models import WebhookDelivery

pytestmark = [pytest.mark.django_db, pytest.mark.req("INT-001")]


class FakeSession:
    def __init__(self, status=200):
        self.status, self.calls = status, []

    def post(self, url, data, headers, timeout, allow_redirects):
        self.calls.append({"url": url, "data": data, "headers": headers})
        return SimpleNamespace(status_code=self.status)


@pytest.fixture
def hook(org, company, make_user, grant, ctx, settings, monkeypatch):
    FeatureFlag.objects.create(key="module.integrations", enabled_default=True)
    admin = make_user()
    grant(admin, ["integrations.webhook.create", "integrations.webhook.read", "integrations.webhook.manage"], org)
    monkeypatch.setattr(services, "check_destination", lambda url: None)  # no real DNS in tests
    endpoint, secret = services.create_endpoint(
        ctx(admin), organization=org, name="WMS", url="https://wms.example.com/hooks", event_types=["sales.*"]
    )
    return endpoint, secret, admin


def test_subscribed_events_are_delivered_signed(hook, company):
    endpoint, secret, _ = hook
    with transaction.atomic():
        publish_event(
            "sales.invoice.posted",
            aggregate_type="sales.invoice",
            aggregate_id=company.pk,
            company_id=company.pk,
            payload={"number": "SI/1"},
        )
        publish_event(
            "hr.payroll_run.posted", aggregate_type="hr.payroll_run", aggregate_id=company.pk, company_id=company.pk
        )
    relay_batch()
    relay_batch()  # handler is idempotent: no duplicate delivery
    assert list(WebhookDelivery.objects.values_list("event_type", flat=True)) == ["sales.invoice.posted"]
    session = FakeSession()
    assert services.deliver_due(session=session) == 1
    call = session.calls[0]
    body, headers = call["data"], call["headers"]
    expected = hmac.new(secret.encode(), f"{headers['X-ERP-Timestamp']}.".encode() + body, hashlib.sha256).hexdigest()
    assert headers["X-ERP-Signature"] == f"sha256={expected}"
    assert json.loads(body)["data"] == {"number": "SI/1"}
    assert WebhookDelivery.objects.get().status == "succeeded"


def test_failures_back_off_then_give_up(hook, company):
    endpoint, _, _ = hook
    delivery = WebhookDelivery.objects.create(
        endpoint=endpoint, event_id=company.pk, event_type="sales.x", body={}, next_attempt_at="2000-01-01T00:00:00Z"
    )
    for _ in range(services.MAX_ATTEMPTS):
        services.deliver(WebhookDelivery.objects.get(pk=delivery.pk), session=FakeSession(503))
    delivery.refresh_from_db()
    assert delivery.status == "dead" and delivery.last_error == "HTTP 503"


def test_validation_and_ssrf_guard(org, company, ctx, make_user, grant, settings):
    FeatureFlag.objects.create(key="module.integrations", enabled_default=True)
    admin = make_user()
    grant(admin, ["integrations.webhook.create"], org)
    with pytest.raises(ValidationError):
        services.create_endpoint(
            ctx(admin), organization=org, name="x", url="http://a.example", event_types=["sales.*"]
        )
    with pytest.raises(ValidationError):
        services.create_endpoint(ctx(admin), organization=org, name="x", url="https://a.example", event_types=["*"])
    for url in ("https://127.0.0.1/h", "https://169.254.169.254/latest", "https://10.1.2.3/h"):
        with pytest.raises(services.UnsafeDestination):
            services.check_destination(url)
    settings.ERP = {**settings.ERP, "WEBHOOK_ALLOWED_PRIVATE_NETWORKS": ["10.1.0.0/16"]}
    services.check_destination("https://10.1.2.3/h")  # explicitly allowed on-premise range


def test_secret_is_shown_once_and_rotates(hook, ctx, api_for):
    endpoint, secret, admin = hook
    client = api_for(admin)
    detail = client.get(f"/api/v1/integrations/webhooks/{endpoint.pk}/").json()
    assert "secret" not in json.dumps(detail) and secret not in json.dumps(detail)
    rotated = client.post(f"/api/v1/integrations/webhooks/{endpoint.pk}/rotate-secret/")
    assert rotated.status_code == 200 and rotated.json()["secret"].startswith("whsec_")
    assert rotated.json()["secret"] != secret
