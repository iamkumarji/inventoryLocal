from django.db import models

from apps.core.models import ActorStampedModel, AuthzResourceMixin, UUIDModel, VersionedModel


class WebhookEndpoint(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    """An external system notified of ERP events. Payloads carry identifiers and small figures only;
    receivers fetch details through the API with their own credentials."""

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    company = models.ForeignKey(
        "organization.Company", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )  # null: events of every company in the organization
    name = models.CharField(max_length=120)
    url = models.URLField(max_length=500)
    # Exact event types ("sales.invoice.posted") or module prefixes ("procurement.*"); never a bare "*".
    event_types = models.JSONField(default=list)
    secret_encrypted = models.TextField()
    is_active = models.BooleanField(default=True)

    authz_resource_type = "integrations.webhook"
    authz_scope_fields = {"organization": "organization_id", "company": "company_id"}

    class Meta:
        db_table = "webhook_endpoints"

    def subscribes_to(self, event_type: str) -> bool:
        return any(
            event_type == pattern or (pattern.endswith(".*") and event_type.startswith(pattern[:-1]))
            for pattern in self.event_types
        )


class WebhookDelivery(UUIDModel):
    class Status(models.TextChoices):
        PENDING = "pending"
        SUCCEEDED = "succeeded"
        FAILED = "failed"  # will retry
        DEAD = "dead"  # gave up; can be redelivered by an administrator

    endpoint = models.ForeignKey(WebhookEndpoint, on_delete=models.CASCADE, related_name="deliveries")
    event_id = models.UUIDField()
    event_type = models.CharField(max_length=150)
    body = models.JSONField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    next_attempt_at = models.DateTimeField()
    last_status_code = models.PositiveSmallIntegerField(null=True, blank=True)
    last_error = models.CharField(max_length=500, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "webhook_deliveries"
        constraints = [models.UniqueConstraint(fields=["endpoint", "event_id"], name="uq_webhook_delivery_event")]
        indexes = [models.Index(fields=["status", "next_attempt_at"], name="ix_webhook_due")]
