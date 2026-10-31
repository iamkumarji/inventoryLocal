import logging

from celery import shared_task
from django.conf import settings
from django.core.mail import send_mail

from .models import Notification

logger = logging.getLogger("erp.notifications")


@shared_task(
    name="apps.notifications.tasks.send_notification_email",
    ignore_result=True,
    autoretry_for=(OSError,),
    retry_backoff=True,
    max_retries=5,
)
def send_notification_email(notification_id: str) -> None:
    notification = Notification.objects.select_related("recipient").filter(pk=notification_id).first()
    if notification is None or not notification.recipient.is_active:
        return
    link = f"{settings.ERP['WEB_BASE_URL'].rstrip('/')}{notification.link}" if notification.link else ""
    body = "\n\n".join(part for part in (notification.body, link) if part)
    send_mail(
        subject=f"[OtabuPro ERP] {notification.title}",
        message=body or notification.title,
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[notification.recipient.email],
    )
