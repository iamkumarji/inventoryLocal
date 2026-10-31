from django.db import models

from apps.core.models import AuthzResourceMixin, UUIDModel


class AuditEvent(AuthzResourceMixin, UUIDModel):
    """Append-only audit record (UPDATE/DELETE blocked by a database trigger)."""

    class Outcome(models.TextChoices):
        SUCCESS = "success"
        DENIED = "denied"
        FAILURE = "failure"

    class ActorType(models.TextChoices):
        USER = "user"
        SYSTEM = "system"
        SERVICE = "service"
        ANONYMOUS = "anonymous"

    occurred_at = models.DateTimeField()
    organization_id = models.UUIDField(null=True, blank=True)
    company_id = models.UUIDField(null=True, blank=True)
    actor_id = models.UUIDField(null=True, blank=True)
    actor_type = models.CharField(max_length=10, choices=ActorType.choices)
    actor_label = models.CharField(max_length=254, blank=True)
    action = models.CharField(max_length=150)
    resource_type = models.CharField(max_length=100, blank=True)
    resource_id = models.CharField(max_length=64, blank=True)
    summary = models.CharField(max_length=500, blank=True)
    changes = models.JSONField(default=dict, blank=True)
    outcome = models.CharField(max_length=10, choices=Outcome.choices, default=Outcome.SUCCESS)
    request_id = models.CharField(max_length=64, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=300, blank=True)
    content_hash = models.CharField(max_length=64)

    authz_resource_type = "audit.audit_event"
    authz_scope_fields = {"organization": "organization_id", "company": "company_id"}

    class Meta:
        db_table = "audit_events"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(outcome__in=["success", "denied", "failure"]), name="ck_audit_outcome"
            ),
        ]
        indexes = [
            models.Index(fields=["company_id", "occurred_at"], name="ix_audit_company_time"),
            models.Index(fields=["resource_type", "resource_id"], name="ix_audit_resource"),
            models.Index(fields=["actor_id", "occurred_at"], name="ix_audit_actor_time"),
            models.Index(fields=["action", "occurred_at"], name="ix_audit_action_time"),
        ]


class AuditChainSeal(UUIDModel):
    """Hash chain over audit events, appended by a single sealing job (also append-only).

    Sealing asynchronously avoids serialising every business transaction on a
    global chain lock while still making tampering detectable.
    """

    seq = models.PositiveBigIntegerField(unique=True)
    event = models.OneToOneField(AuditEvent, on_delete=models.PROTECT, related_name="seal")
    prev_hash = models.CharField(max_length=64)
    chain_hash = models.CharField(max_length=64)
    sealed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "audit_chain_seals"
