"""Outbound webhooks: subscriptions, signed delivery with retries, SSRF guard."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import secrets
import socket
import time
from datetime import timedelta
from urllib.parse import urlsplit

import requests
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.crypto import decrypt_str, encrypt_str
from apps.core.ids import uuid7
from apps.shared import workflow

from .models import WebhookDelivery, WebhookEndpoint

WEBHOOK = "integrations.webhook"
MAX_ATTEMPTS = 10
TIMEOUT = (5, 10)  # connect, read seconds
USER_AGENT = "OtabuPro-ERP-Webhooks/1"


# --- Subscriptions ---------------------------------------------------------------------------------


def _check_event_types(event_types) -> list[str]:
    if not isinstance(event_types, list) or not event_types:
        raise ValidationError({"event_types": ["Choose at least one event type or module (e.g. procurement.*)."]})
    clean = []
    for pattern in event_types:
        if not isinstance(pattern, str) or not pattern or pattern in ("*", ".*") or pattern.count("*") > 1:
            raise ValidationError({"event_types": [f"'{pattern}' is not allowed: subscribe to events or modules."]})
        if "*" in pattern and not pattern.endswith(".*"):
            raise ValidationError({"event_types": [f"'{pattern}': a wildcard may only end a module prefix."]})
        clean.append(pattern.strip())
    return sorted(set(clean))


def _check_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https" and not settings.ERP.get("WEBHOOK_ALLOW_HTTP", False):
        raise ValidationError({"url": ["Use an https:// address."]})
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValidationError({"url": ["Enter a full http(s) address."]})
    if parts.username or parts.password:
        raise ValidationError({"url": ["Credentials in the address aren't allowed; the signature authenticates us."]})
    return url


def _new_secret() -> str:
    return f"whsec_{secrets.token_urlsafe(32)}"


@transaction.atomic
def create_endpoint(ctx: ActorContext, *, organization, name: str, url: str, event_types, company=None):
    """Returns (endpoint, secret). The secret is shown once; only its encrypted form is stored."""
    scope = {"organization_id": organization.pk, **({"company_id": company.pk} if company is not None else {})}
    pdp.require(ctx, f"{WEBHOOK}.create", pdp.Resource.ref(WEBHOOK, **scope))
    if company is not None and company.organization_id != organization.pk:
        raise ValidationError({"company": ["Company belongs to another organization."]})
    secret = _new_secret()
    endpoint = WebhookEndpoint.objects.create(
        organization=organization,
        company=company,
        name=name,
        url=_check_url(url),
        event_types=_check_event_types(event_types),
        secret_encrypted=encrypt_str(secret),
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        f"{WEBHOOK}.created",
        ctx=ctx,
        resource_type=WEBHOOK,
        resource_id=endpoint.pk,
        organization_id=organization.pk,
        summary=f"{name} → {endpoint.url}",
        changes={"event_types": endpoint.event_types},
    )
    return endpoint, secret


@transaction.atomic
def update_endpoint(ctx: ActorContext, endpoint: WebhookEndpoint, *, expected_version, **changes) -> WebhookEndpoint:
    endpoint = WebhookEndpoint.objects.select_for_update().get(pk=endpoint.pk)
    pdp.require(ctx, f"{WEBHOOK}.update", pdp.Resource.of(endpoint))
    if expected_version is not None and expected_version != endpoint.version:
        from apps.core.exceptions import VersionConflict

        raise VersionConflict()
    if "url" in changes:
        changes["url"] = _check_url(changes["url"])
    if "event_types" in changes:
        changes["event_types"] = _check_event_types(changes["event_types"])
    before = {k: getattr(endpoint, k) for k in changes}
    workflow.bump(endpoint, ctx, **changes)
    audit.record(
        f"{WEBHOOK}.updated",
        ctx=ctx,
        resource_type=WEBHOOK,
        resource_id=endpoint.pk,
        organization_id=endpoint.organization_id,
        summary=endpoint.name,
        changes=audit.diff(before, {k: getattr(endpoint, k) for k in changes}),
    )
    return endpoint


@transaction.atomic
def rotate_secret(ctx: ActorContext, endpoint: WebhookEndpoint) -> str:
    endpoint = WebhookEndpoint.objects.select_for_update().get(pk=endpoint.pk)
    pdp.require(ctx, f"{WEBHOOK}.manage", pdp.Resource.of(endpoint))
    secret = _new_secret()
    workflow.bump(endpoint, ctx, secret_encrypted=encrypt_str(secret))
    audit.record(
        f"{WEBHOOK}.secret_rotated",
        ctx=ctx,
        resource_type=WEBHOOK,
        resource_id=endpoint.pk,
        organization_id=endpoint.organization_id,
        summary=endpoint.name,
    )
    return secret


# --- Fan-out (outbox handler) ------------------------------------------------------------------------


def enqueue_for_event(event) -> int:
    """Create one delivery per subscribed endpoint. Idempotent per (endpoint, event)."""
    if event.company_id is None:
        return 0
    from apps.core import flags
    from apps.organization.models import Company

    if not flags.is_enabled(flags.module_flag_key("integrations"), company_id=event.company_id):
        return 0
    org_id = Company.objects.filter(pk=event.company_id).values_list("organization_id", flat=True).first()
    if org_id is None:
        return 0
    endpoints = WebhookEndpoint.objects.filter(organization_id=org_id, is_active=True).filter(
        models_q_company(event.company_id)
    )
    body = {
        "id": str(event.id),
        "type": event.event_type,
        "occurred_at": event.occurred_at.isoformat(),
        "company_id": str(event.company_id),
        "aggregate": {"type": event.aggregate_type, "id": str(event.aggregate_id)},
        "data": event.payload,
    }
    created = 0
    for endpoint in endpoints:
        if not endpoint.subscribes_to(event.event_type):
            continue
        try:
            with transaction.atomic():
                WebhookDelivery.objects.create(
                    endpoint=endpoint,
                    event_id=event.id,
                    event_type=event.event_type,
                    body=body,
                    next_attempt_at=timezone.now(),
                )
            created += 1
        except IntegrityError:
            pass  # already queued by an earlier attempt of this handler
    return created


def models_q_company(company_id):
    from django.db.models import Q

    return Q(company_id=company_id) | Q(company__isnull=True)


# --- Delivery -----------------------------------------------------------------------------------------


class UnsafeDestination(Exception):
    pass


def _allowed_private() -> list:
    return [ipaddress.ip_network(c) for c in settings.ERP.get("WEBHOOK_ALLOWED_PRIVATE_NETWORKS", [])]


def check_destination(url: str) -> None:
    """Refuse loopback, link-local (cloud metadata), multicast and reserved addresses always, and private
    ranges unless explicitly allowed (on-premise integrations). Residual risk: DNS can change between
    this check and the connection; keep allowed private ranges narrow."""
    host = urlsplit(url).hostname or ""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise UnsafeDestination(f"cannot resolve {host}") from exc
    allowed = _allowed_private()
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
            raise UnsafeDestination(f"{host} resolves to a blocked address")
        if ip.is_private and not any(ip in net for net in allowed):
            raise UnsafeDestination(f"{host} resolves to a private address that isn't allowed")


def sign(secret: str, timestamp: int, body: bytes) -> str:
    mac = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return f"sha256={mac}"


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(6 * 3600, 30 * 2 ** max(0, attempts - 1)))


def deliver(delivery: WebhookDelivery, session=None) -> WebhookDelivery:
    endpoint = delivery.endpoint
    body = json.dumps(delivery.body, separators=(",", ":"), sort_keys=True).encode()
    timestamp = int(time.time())
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-ERP-Event": delivery.event_type,
        "X-ERP-Delivery": str(delivery.pk),
        "X-ERP-Timestamp": str(timestamp),
        "X-ERP-Signature": sign(decrypt_str(endpoint.secret_encrypted), timestamp, body),
    }
    delivery.attempts += 1
    try:
        check_destination(endpoint.url)
        response = (session or requests).post(
            endpoint.url, data=body, headers=headers, timeout=TIMEOUT, allow_redirects=False
        )
        delivery.last_status_code = response.status_code
        ok = 200 <= response.status_code < 300
        delivery.last_error = "" if ok else f"HTTP {response.status_code}"
    except UnsafeDestination as exc:
        ok, delivery.last_status_code, delivery.last_error = False, None, f"blocked: {exc}"[:500]
    except requests.RequestException as exc:
        ok, delivery.last_status_code, delivery.last_error = False, None, exc.__class__.__name__
    if ok:
        delivery.status, delivery.delivered_at = WebhookDelivery.Status.SUCCEEDED, timezone.now()
    elif delivery.attempts >= MAX_ATTEMPTS:
        delivery.status = WebhookDelivery.Status.DEAD
    else:
        delivery.status = WebhookDelivery.Status.FAILED
        delivery.next_attempt_at = timezone.now() + _backoff(delivery.attempts)
    delivery.save()
    return delivery


def deliver_due(batch: int = 50, session=None) -> int:
    with transaction.atomic():
        due = list(
            WebhookDelivery.objects.select_for_update(skip_locked=True, of=("self",))
            .select_related("endpoint")
            .filter(status__in=["pending", "failed"], next_attempt_at__lte=timezone.now(), endpoint__is_active=True)
            .order_by("next_attempt_at")[:batch]
        )
        for delivery in due:
            deliver(delivery, session=session)
    return len(due)


@transaction.atomic
def redeliver(ctx: ActorContext, delivery: WebhookDelivery) -> WebhookDelivery:
    delivery = WebhookDelivery.objects.select_for_update(of=("self",)).select_related("endpoint").get(pk=delivery.pk)
    pdp.require(ctx, f"{WEBHOOK}.manage", pdp.Resource.of(delivery.endpoint))
    delivery.status, delivery.attempts, delivery.next_attempt_at = WebhookDelivery.Status.PENDING, 0, timezone.now()
    delivery.save(update_fields=["status", "attempts", "next_attempt_at"])
    return delivery


@transaction.atomic
def send_test(ctx: ActorContext, endpoint: WebhookEndpoint) -> WebhookDelivery:
    pdp.require(ctx, f"{WEBHOOK}.manage", pdp.Resource.of(endpoint))
    event_id = uuid7()
    return WebhookDelivery.objects.create(
        endpoint=endpoint,
        event_id=event_id,
        event_type="webhook.ping",
        next_attempt_at=timezone.now(),
        body={"id": str(event_id), "type": "webhook.ping", "occurred_at": timezone.now().isoformat(), "data": {}},
    )
