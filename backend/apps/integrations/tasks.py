from celery import shared_task

from . import services


@shared_task(name="apps.integrations.tasks.deliver_webhooks", ignore_result=True)
def deliver_webhooks() -> int:
    total = 0
    while (count := services.deliver_due()) > 0:
        total += count
        if total >= 500:  # leave the rest for the next beat tick
            break
    return total
