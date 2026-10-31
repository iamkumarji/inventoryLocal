from datetime import timedelta

from celery import shared_task
from django.utils import timezone

from .models import IdempotencyKey, OutboxEvent


@shared_task(name="apps.core.tasks.relay_outbox", ignore_result=True)
def relay_outbox() -> int:
    from .outbox import relay_batch

    total = 0
    while True:
        processed = relay_batch()
        total += processed
        if processed == 0:
            return total


@shared_task(name="apps.core.tasks.purge_expired_records", ignore_result=True)
def purge_expired_records() -> None:
    now = timezone.now()
    IdempotencyKey.objects.filter(expires_at__lt=now).delete()
    OutboxEvent.objects.filter(status=OutboxEvent.Status.PUBLISHED, published_at__lt=now - timedelta(days=30)).delete()
