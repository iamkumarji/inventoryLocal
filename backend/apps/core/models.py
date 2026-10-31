from django.conf import settings
from django.db import models

from .ids import uuid7

# Attribute names the PDP reads from any resource when present.
STANDARD_AUTHZ_ATTRIBUTES = (
    "id",
    "organization_id",
    "company_id",
    "branch_id",
    "facility_id",
    "warehouse_id",
    "department_id",
    "created_by_id",
    "submitted_by_id",
    "owner_id",
    "employee_id",
    "status",
    "amount",
    "currency",
)


class UUIDModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    class Meta:
        abstract = True


class TimeStampedModel(UUIDModel):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class ActorStampedModel(TimeStampedModel):
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        abstract = True


class VersionedModel(models.Model):
    """Optimistic locking: services bump `version` on every update and compare the client's value."""

    version = models.PositiveIntegerField(default=1)

    class Meta:
        abstract = True


class AuthzResourceMixin:
    """Declares how a model participates in authorization.

    `authz_resource_type`: "<module>.<resource>" matching permission codes.
    `authz_scope_fields`: scope level -> attribute/field name, used both for
    object checks and for queryset scope filtering.
    """

    authz_resource_type: str = ""
    authz_scope_fields: dict[str, str] = {}

    def authz_attributes(self) -> dict:
        attrs = {"type": self.authz_resource_type}
        for name in STANDARD_AUTHZ_ATTRIBUTES:
            if hasattr(self, name):
                attrs[name] = getattr(self, name)
        for field_name in self.authz_scope_fields.values():
            attrs.setdefault(field_name, getattr(self, field_name, None))
        return attrs


class CompanyScopedModel(AuthzResourceMixin, ActorStampedModel):
    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")

    authz_scope_fields = {"company": "company_id"}

    class Meta:
        abstract = True


# --- Concrete platform tables ---------------------------------------------------


class IdempotencyKey(UUIDModel):
    class Status(models.TextChoices):
        IN_PROGRESS = "in_progress"
        COMPLETED = "completed"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    key = models.CharField(max_length=255)
    method = models.CharField(max_length=10)
    path = models.CharField(max_length=512)
    request_hash = models.CharField(max_length=64)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.IN_PROGRESS)
    response_status = models.PositiveSmallIntegerField(null=True)
    response_body = models.JSONField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()

    class Meta:
        db_table = "idempotency_keys"
        constraints = [
            models.UniqueConstraint(fields=["user", "key"], name="uq_idempotency_user_key"),
            models.CheckConstraint(
                condition=models.Q(status__in=["in_progress", "completed"]), name="ck_idempotency_status"
            ),
        ]
        indexes = [models.Index(fields=["expires_at"], name="ix_idempotency_expires")]


class OutboxEvent(UUIDModel):
    class Status(models.TextChoices):
        PENDING = "pending"
        PUBLISHED = "published"
        FAILED = "failed"
        DEAD = "dead"

    company_id = models.UUIDField(null=True, blank=True)
    event_type = models.CharField(max_length=150)
    aggregate_type = models.CharField(max_length=100)
    aggregate_id = models.UUIDField()
    payload = models.JSONField(default=dict)
    request_id = models.CharField(max_length=64, blank=True)
    occurred_at = models.DateTimeField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveIntegerField(default=0)
    next_attempt_at = models.DateTimeField()
    last_error = models.TextField(blank=True)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "outbox_events"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["pending", "published", "failed", "dead"]), name="ck_outbox_status"
            )
        ]
        indexes = [
            models.Index(
                fields=["next_attempt_at"],
                name="ix_outbox_due",
                condition=models.Q(status__in=["pending", "failed"]),
            ),
            models.Index(fields=["aggregate_type", "aggregate_id"], name="ix_outbox_aggregate"),
        ]


class InboxReceipt(UUIDModel):
    handler = models.CharField(max_length=200)
    event = models.ForeignKey(OutboxEvent, on_delete=models.CASCADE, related_name="receipts")
    processed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "inbox_receipts"
        constraints = [models.UniqueConstraint(fields=["handler", "event"], name="uq_inbox_handler_event")]


class FeatureFlag(AuthzResourceMixin, TimeStampedModel):
    """Feature flag with targeting (organization-wide: no company scope).

    `rules` = {"users": {"<uuid>": bool}, "roles": {"<code>": bool}, "companies": {"<uuid>": bool}}
    Precedence: user > role > company > enabled_default. Unknown flags are disabled.
    """

    key = models.CharField(max_length=100, unique=True)
    description = models.TextField(blank=True)
    enabled_default = models.BooleanField(default=False)
    rules = models.JSONField(default=dict, blank=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    authz_resource_type = "core.feature_flag"

    class Meta:
        db_table = "feature_flags"


class OrganizationFeatureFlag(TimeStampedModel):
    """One organization's setting for a flag. Overrides the platform default for that organization only,
    so tenants switch modules and target roles/companies without affecting each other."""

    organization = models.ForeignKey("organization.Organization", on_delete=models.CASCADE, related_name="+")
    key = models.CharField(max_length=100)
    enabled = models.BooleanField(default=False)
    rules = models.JSONField(default=dict, blank=True)  # same shape as FeatureFlag.rules, scoped to this org
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        db_table = "organization_feature_flags"
        constraints = [models.UniqueConstraint(fields=["organization", "key"], name="uq_org_feature_flag")]

    def __str__(self) -> str:
        return self.key


class SharedMasterMixin(AuthzResourceMixin):
    """Organization-wide master data, visible to grants at any level within the organization."""

    authz_scope_fields = {"shared": "organization_id"}
