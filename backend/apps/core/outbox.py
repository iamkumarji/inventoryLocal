"""Transactional outbox (ARCHITECTURE §5.4).

`publish_event` must be called inside the business transaction. The relay
claims due events with SKIP LOCKED, runs registered handlers idempotently
(InboxReceipt per handler/event) and retries with exponential backoff.
Critical stock/accounting changes must never be implemented as handlers.
"""

import logging
from collections import defaultdict
from collections.abc import Callable
from datetime import timedelta
from uuid import UUID

from django.conf import settings
from django.core.serializers.json import DjangoJSONEncoder
from django.db import connection, transaction
from django.utils import timezone

from .context import current_request_id
from .models import InboxReceipt, OutboxEvent

logger = logging.getLogger("erp.outbox")

Handler = Callable[[OutboxEvent], None]
_handlers: dict[str, list[tuple[str, Handler]]] = defaultdict(list)


def register_handler(event_type: str, name: str | None = None):
    """Register an idempotent side-effect handler. `event_type` may be '*'."""

    def decorator(func: Handler) -> Handler:
        handler_name = name or f"{func.__module__}.{func.__qualname__}"
        if handler_name not in {n for n, _ in _handlers[event_type]}:
            _handlers[event_type].append((handler_name, func))
        return func

    return decorator


def handlers_for(event_type: str) -> list[tuple[str, Handler]]:
    return [*_handlers.get(event_type, []), *_handlers.get("*", [])]


def _json_safe(payload: dict) -> dict:
    import json

    return json.loads(json.dumps(payload, cls=DjangoJSONEncoder))


def publish_event(
    event_type: str,
    *,
    aggregate_type: str,
    aggregate_id: UUID,
    payload: dict | None = None,
    company_id: UUID | None = None,
) -> OutboxEvent:
    if not connection.in_atomic_block:
        raise RuntimeError("publish_event must be called inside transaction.atomic()")
    now = timezone.now()
    event = OutboxEvent.objects.create(
        company_id=company_id,
        event_type=event_type,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        payload=_json_safe(payload or {}),
        request_id=current_request_id(),
        occurred_at=now,
        next_attempt_at=now,
    )
    if settings.ERP["OUTBOX_NUDGE_ON_COMMIT"]:
        transaction.on_commit(_nudge_relay)
    return event


def _nudge_relay() -> None:
    try:
        from .tasks import relay_outbox

        relay_outbox.delay()
    except Exception:  # noqa: BLE001 - broker down: the beat schedule picks events up later
        logger.warning("outbox nudge failed; relying on scheduled relay")


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(2**attempts * 5, 3600))


def relay_batch(batch_size: int | None = None) -> int:
    """Process one batch of due events. Returns the number of events processed."""
    batch_size = batch_size or settings.ERP["OUTBOX_BATCH_SIZE"]
    max_attempts = settings.ERP["OUTBOX_MAX_ATTEMPTS"]
    processed = 0
    with transaction.atomic():
        events = list(
            OutboxEvent.objects.select_for_update(skip_locked=True)
            .filter(
                status__in=[OutboxEvent.Status.PENDING, OutboxEvent.Status.FAILED], next_attempt_at__lte=timezone.now()
            )
            .order_by("next_attempt_at", "id")[:batch_size]
        )
        for event in events:
            processed += 1
            done = set(InboxReceipt.objects.filter(event=event).values_list("handler", flat=True))
            error = None
            for handler_name, handler in handlers_for(event.event_type):
                if handler_name in done:
                    continue
                try:
                    with transaction.atomic():
                        handler(event)
                        InboxReceipt.objects.create(handler=handler_name, event=event)
                except Exception as exc:  # noqa: BLE001 - isolate handler failures
                    logger.exception(
                        "outbox handler failed", extra={"handler": handler_name, "event_id": str(event.id)}
                    )
                    error = f"{handler_name}: {exc}"
                    break
            event.attempts += 1
            if error is None:
                event.status = OutboxEvent.Status.PUBLISHED
                event.published_at = timezone.now()
                event.last_error = ""
            else:
                event.last_error = error[:4000]
                event.status = OutboxEvent.Status.DEAD if event.attempts >= max_attempts else OutboxEvent.Status.FAILED
                event.next_attempt_at = timezone.now() + _backoff(event.attempts)
            event.save(update_fields=["attempts", "status", "published_at", "last_error", "next_attempt_at"])
    return processed
