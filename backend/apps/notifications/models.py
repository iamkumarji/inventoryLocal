from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import TimeStampedModel, UUIDModel


class Category(models.TextChoices):
    APPROVAL = "approval"
    TASK = "task"
    SECURITY = "security"
    SYSTEM = "system"


class Channel(models.TextChoices):
    IN_APP = "in_app"
    EMAIL = "email"
    PUSH = "push"


class Notification(UUIDModel):
    """An in-app notification for one recipient. Contains summaries and links only, never sensitive values."""

    class Severity(models.TextChoices):
        INFO = "info"
        WARNING = "warning"
        CRITICAL = "critical"

    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    organization_id = models.UUIDField(null=True, blank=True)
    company_id = models.UUIDField(null=True, blank=True)
    category = models.CharField(max_length=20, choices=Category.choices)
    severity = models.CharField(max_length=10, choices=Severity.choices, default=Severity.INFO)
    title = models.CharField(max_length=200)
    body = models.CharField(max_length=1000, blank=True)
    link = models.CharField(max_length=300, blank=True)
    resource_type = models.CharField(max_length=100, blank=True)
    resource_id = models.CharField(max_length=64, blank=True)
    dedupe_key = models.CharField(max_length=200, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "notifications"
        constraints = [
            models.UniqueConstraint(
                fields=["recipient", "dedupe_key"], name="uq_notification_dedupe", condition=~Q(dedupe_key="")
            ),
            models.CheckConstraint(
                condition=Q(category__in=["approval", "task", "security", "system"]), name="ck_notification_category"
            ),
        ]
        indexes = [
            models.Index(fields=["recipient", "-created_at"], name="ix_notification_recipient"),
            models.Index(fields=["recipient"], name="ix_notification_unread", condition=Q(read_at__isnull=True)),
        ]


class NotificationPreference(TimeStampedModel):
    """Opt-out store: a missing row means the channel default applies (in-app on, email on, push off)."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notification_preferences"
    )
    category = models.CharField(max_length=20, choices=Category.choices)
    channel = models.CharField(max_length=10, choices=Channel.choices)
    enabled = models.BooleanField(default=True)

    class Meta:
        db_table = "notification_preferences"
        constraints = [
            models.UniqueConstraint(fields=["user", "category", "channel"], name="uq_notification_preference")
        ]
