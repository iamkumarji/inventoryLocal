from celery import shared_task
from django.utils.dateparse import parse_datetime

from .services import escalate_overdue_tasks as _escalate


@shared_task(name="apps.collaboration.tasks.escalate_overdue_tasks", ignore_result=True)
def escalate_overdue_tasks(now: str | None = None) -> int:
    """Beat entry point. `now` (ISO-8601) is optional and only used for replays/backfills."""
    return _escalate(parse_datetime(now) if now else None)
