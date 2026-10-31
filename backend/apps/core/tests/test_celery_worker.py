"""Runs a real Celery worker (in-memory broker) to prove tasks execute outside the request path."""

import time

import pytest
from celery.contrib.testing.worker import start_worker
from django.db import transaction

from apps.core.ids import uuid7
from apps.core.models import OutboxEvent
from apps.core.outbox import _handlers, publish_event, register_handler
from apps.core.tasks import relay_outbox
from config.celery import app as celery_app

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def worker_app():
    previous = {k: celery_app.conf.get(k) for k in ("broker_url", "result_backend", "task_always_eager")}
    celery_app.conf.update(broker_url="memory://", result_backend="cache+memory://", task_always_eager=False)
    yield celery_app
    celery_app.conf.update(previous)


def test_worker_relays_outbox_events(worker_app):
    seen = []
    saved = {k: list(v) for k, v in _handlers.items()}
    register_handler("test.worker", name="worker_collector")(lambda event: seen.append(event.pk))
    try:
        with transaction.atomic():
            event = publish_event("test.worker", aggregate_type="test", aggregate_id=uuid7())
        with start_worker(worker_app, pool="solo", perform_ping_check=False, shutdown_timeout=10):
            relay_outbox.delay()
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                event.refresh_from_db()
                if event.status == OutboxEvent.Status.PUBLISHED:
                    break
                time.sleep(0.1)
        assert event.status == OutboxEvent.Status.PUBLISHED
        assert seen == [event.pk]
    finally:
        _handlers.clear()
        _handlers.update(saved)
