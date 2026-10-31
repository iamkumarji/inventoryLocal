from celery import shared_task
from django.utils import timezone

from apps.core.context import ActorContext

from .services import generate_due_work_orders


@shared_task(name="apps.assets.tasks.generate_preventive_work_orders", ignore_result=True)
def generate_preventive_work_orders() -> int:
    """Daily: open preventive work orders for due maintenance plans (idempotent)."""
    ctx = ActorContext.system("assets.preventive_maintenance")
    return len(generate_due_work_orders(ctx, timezone.localdate()))
