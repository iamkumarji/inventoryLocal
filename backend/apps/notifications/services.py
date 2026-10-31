"""Notification delivery: in-app rows, live WebSocket push and email (async).

Security and approval notifications can't be switched off in-app; users may
opt out of email/push per category.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from uuid import UUID

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import Category, Channel, Notification, NotificationPreference

logger = logging.getLogger("erp.notifications")

CHANNEL_DEFAULTS = {Channel.IN_APP: True, Channel.EMAIL: True, Channel.PUSH: False}
MANDATORY_IN_APP = {Category.APPROVAL, Category.SECURITY}


def channel_enabled(user_id: UUID, category: str, channel: str) -> bool:
    if channel == Channel.IN_APP and category in MANDATORY_IN_APP:
        return True
    pref = NotificationPreference.objects.filter(user_id=user_id, category=category, channel=channel).first()
    return pref.enabled if pref is not None else CHANNEL_DEFAULTS[channel]


def unread_count(user_id: UUID) -> int:
    return Notification.objects.filter(recipient_id=user_id, read_at__isnull=True).count()


def push_to_user(user_id: UUID, message: dict) -> None:
    """Best-effort live push; the REST API remains the source of truth."""
    layer = get_channel_layer()
    if layer is None:
        return
    try:
        async_to_sync(layer.group_send)(f"user.{user_id}", {"type": "stream.message", "message": message})
    except Exception:  # noqa: BLE001 - realtime is best effort
        logger.warning("websocket push failed", extra={"user_id": str(user_id)})


def notify(
    recipients: Iterable,
    *,
    category: str,
    title: str,
    body: str = "",
    link: str = "",
    resource_type: str = "",
    resource_id: str | UUID = "",
    severity: str = Notification.Severity.INFO,
    dedupe_key: str = "",
    organization_id: UUID | None = None,
    company_id: UUID | None = None,
) -> list[Notification]:
    created: list[Notification] = []
    for user in {r.pk: r for r in recipients if r is not None and r.is_active}.values():
        if not channel_enabled(user.pk, category, Channel.IN_APP):
            continue
        try:
            with transaction.atomic():
                created.append(
                    Notification.objects.create(
                        recipient=user,
                        organization_id=organization_id or user.organization_id,
                        company_id=company_id,
                        category=category,
                        severity=severity,
                        title=title[:200],
                        body=body[:1000],
                        link=link[:300],
                        resource_type=resource_type,
                        resource_id=str(resource_id or "")[:64],
                        dedupe_key=dedupe_key[:200],
                    )
                )
        except IntegrityError:
            continue  # already notified for this dedupe key

    def _after_commit():
        from .tasks import send_notification_email

        for notification in created:
            push_to_user(
                notification.recipient_id,
                {
                    "type": "notification.created",
                    "id": str(notification.pk),
                    "category": notification.category,
                    "title": notification.title,
                    "link": notification.link,
                    "unread_count": unread_count(notification.recipient_id),
                },
            )
            if channel_enabled(notification.recipient_id, notification.category, Channel.EMAIL):
                try:
                    send_notification_email.delay(str(notification.pk))
                except Exception:  # noqa: BLE001 - broker down: in-app copy already exists
                    logger.warning("email enqueue failed", extra={"notification_id": str(notification.pk)})

    transaction.on_commit(_after_commit)
    return created


def mark_read(user_id: UUID, notification_ids: Iterable[UUID] | None = None) -> int:
    qs = Notification.objects.filter(recipient_id=user_id, read_at__isnull=True)
    if notification_ids is not None:
        qs = qs.filter(pk__in=list(notification_ids))
    count = qs.update(read_at=timezone.now())
    if count:
        transaction.on_commit(
            lambda: push_to_user(user_id, {"type": "notification.read", "unread_count": unread_count(user_id)})
        )
    return count


def set_preferences(user, preferences: list[dict]) -> None:
    for pref in preferences:
        if pref["channel"] == Channel.IN_APP and pref["category"] in MANDATORY_IN_APP and not pref["enabled"]:
            continue  # mandatory; silently kept on
        NotificationPreference.objects.update_or_create(
            user=user, category=pref["category"], channel=pref["channel"], defaults={"enabled": pref["enabled"]}
        )


def effective_preferences(user) -> list[dict]:
    stored = {(p.category, p.channel): p.enabled for p in NotificationPreference.objects.filter(user=user)}
    result = []
    for category in Category.values:
        for channel in Channel.values:
            mandatory = channel == Channel.IN_APP and category in MANDATORY_IN_APP
            enabled = True if mandatory else stored.get((category, channel), CHANNEL_DEFAULTS[channel])
            result.append({"category": category, "channel": channel, "enabled": enabled, "mandatory": mandatory})
    return result
