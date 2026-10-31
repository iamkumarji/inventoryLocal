from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.db.models import F, Q

from apps.core.fields import MoneyField
from apps.core.models import ActorStampedModel, AuthzResourceMixin, TimeStampedModel, UUIDModel, VersionedModel


class ApprovalMatrix(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    """Approval route for a document type. A company-specific matrix overrides the organization-wide one."""

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    company = models.ForeignKey(
        "organization.Company", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    document_type = models.CharField(max_length=100)
    name = models.CharField(max_length=150)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "approvals.approval_matrix"
    authz_scope_fields = {"organization": "organization_id", "company": "company_id"}

    class Meta:
        db_table = "approval_matrices"
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "document_type", "company"],
                name="uq_active_matrix_company",
                condition=Q(is_active=True, company__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["organization", "document_type"],
                name="uq_active_matrix_org",
                condition=Q(is_active=True, company__isnull=True),
            ),
        ]


class ApprovalLevel(UUIDModel):
    """A level applies when the document amount >= min_amount and the optional condition holds."""

    matrix = models.ForeignKey(ApprovalMatrix, on_delete=models.CASCADE, related_name="levels")
    sequence = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=100)
    role = models.ForeignKey("authorization.Role", on_delete=models.PROTECT, related_name="+")
    min_amount = MoneyField(default=0)
    condition = models.JSONField(default=dict, blank=True)
    escalation_hours = models.PositiveIntegerField(null=True, blank=True)
    escalation_role = models.ForeignKey(
        "authorization.Role", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        db_table = "approval_levels"
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(fields=["matrix", "sequence"], name="uq_approval_level_sequence"),
            models.CheckConstraint(condition=Q(min_amount__gte=0), name="ck_approval_level_min_amount"),
        ]


class ApprovalRequest(AuthzResourceMixin, VersionedModel, TimeStampedModel):
    class Status(models.TextChoices):
        PENDING = "pending"
        APPROVED = "approved"
        REJECTED = "rejected"
        WITHDRAWN = "withdrawn"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    # Denormalised scope of the document, used for eligibility and row filtering.
    branch_id = models.UUIDField(null=True, blank=True)
    facility_id = models.UUIDField(null=True, blank=True)
    warehouse_id = models.UUIDField(null=True, blank=True)
    department_id = models.UUIDField(null=True, blank=True)
    document_type = models.CharField(max_length=100)
    document_id = models.UUIDField()
    document_number = models.CharField(max_length=60, blank=True)
    title = models.CharField(max_length=250)
    amount = MoneyField(null=True, blank=True)
    currency = models.CharField(max_length=3, blank=True)
    summary = models.JSONField(default=dict, blank=True)
    matrix = models.ForeignKey(ApprovalMatrix, null=True, on_delete=models.PROTECT, related_name="requests")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    current_sequence = models.PositiveSmallIntegerField(null=True, blank=True)
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    submitted_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True, blank=True)

    authz_resource_type = "approvals.approval_request"
    authz_scope_fields = {
        "company": "company_id",
        "branch": "branch_id",
        "facility": "facility_id",
        "warehouse": "warehouse_id",
        "department": "department_id",
    }

    class Meta:
        db_table = "approval_requests"
        constraints = [
            models.UniqueConstraint(
                fields=["document_type", "document_id"],
                name="uq_pending_approval_per_document",
                condition=Q(status="pending"),
            ),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "approved", "rejected", "withdrawn"]), name="ck_approval_status"
            ),
        ]
        indexes = [
            models.Index(fields=["company", "status", "-submitted_at"], name="ix_approval_company_status"),
            models.Index(fields=["requested_by", "-submitted_at"], name="ix_approval_requested_by"),
            models.Index(fields=["document_type", "document_id"], name="ix_approval_document"),
        ]


class ApprovalStep(UUIDModel):
    """A snapshot of one matrix level for one request. Frozen once decided (database trigger)."""

    class Status(models.TextChoices):
        PENDING = "pending"
        APPROVED = "approved"
        REJECTED = "rejected"
        SKIPPED = "skipped"

    request = models.ForeignKey(ApprovalRequest, on_delete=models.CASCADE, related_name="steps")
    sequence = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=100)
    role = models.ForeignKey("authorization.Role", on_delete=models.PROTECT, related_name="+")
    is_final = models.BooleanField(default=False)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    acting_for = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    comment = models.TextField(blank=True)
    due_at = models.DateTimeField(null=True, blank=True)
    escalated_at = models.DateTimeField(null=True, blank=True)
    escalation_role = models.ForeignKey(
        "authorization.Role", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    escalation_hours = models.PositiveIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "approval_steps"
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(fields=["request", "sequence"], name="uq_approval_step_sequence"),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "approved", "rejected", "skipped"]), name="ck_approval_step_status"
            ),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "skipped"]) | Q(decided_by__isnull=False),
                name="ck_approval_step_decider",
            ),
        ]


class ApprovalDelegation(AuthzResourceMixin, ActorStampedModel):
    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    delegator = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    delegate = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    document_types = ArrayField(models.CharField(max_length=100), default=list, blank=True)  # empty = all
    valid_from = models.DateTimeField()
    valid_until = models.DateTimeField()
    reason = models.CharField(max_length=300)
    revoked_at = models.DateTimeField(null=True, blank=True)

    authz_resource_type = "approvals.delegation"
    authz_scope_fields = {"organization": "organization_id"}

    class Meta:
        db_table = "approval_delegations"
        constraints = [
            models.CheckConstraint(condition=~Q(delegator=F("delegate")), name="ck_delegation_not_self"),
            models.CheckConstraint(condition=Q(valid_until__gt=F("valid_from")), name="ck_delegation_window"),
        ]
        indexes = [models.Index(fields=["delegate", "valid_until"], name="ix_delegation_delegate")]
