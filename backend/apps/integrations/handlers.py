from apps.core.outbox import register_handler

from . import services


@register_handler("*", name="integrations.webhooks.enqueue")
def enqueue_webhooks(event) -> None:
    services.enqueue_for_event(event)
