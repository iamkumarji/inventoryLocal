from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.db.models import F, Q

from apps.core.fields import MoneyField
from apps.core.models import ActorStampedModel, AuthzResourceMixin, TimeStampedModel, UUIDModel, VersionedModel

ACTIONS = (
    "create",
    "read",
    "update",
    "delete",
    "approve",
    "reject",
    "post",
    "cancel",
    "export",
    "download",
    "assign",
    "manage",
)


class Permission(TimeStampedModel):
    """Catalogue entry synced from code registries (apps/*/permissions.py). Read-only via API."""

    code = models.CharField(max_length=150, unique=True)
    module = models.CharField(max_length=50)
    resource = models.CharField(max_length=80)
    action = models.CharField(max_length=30)
    description = models.CharField(max_length=300, blank=True)
    is_sensitive = models.BooleanField(default=False)
    requires_mfa = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "permissions"
        ordering = ["code"]
        indexes = [models.Index(fields=["module", "resource"], name="ix_permission_module_resource")]

    def __str__(self) -> str:
        return self.code


class Role(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="roles")
    code = models.CharField(max_length=60)
    name = models.CharField(max_length=150)
    description = models.TextField(blank=True)
    is_system_template = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    max_session_minutes = models.PositiveIntegerField(null=True, blank=True)
    mfa_required = models.BooleanField(default=False)
    permissions = models.ManyToManyField(Permission, through="RolePermission", related_name="roles")

    authz_resource_type = "authorization.role"
    authz_scope_fields = {"organization": "organization_id"}

    class Meta:
        db_table = "roles"
        constraints = [models.UniqueConstraint(fields=["organization", "code"], name="uq_role_org_code")]

    def __str__(self) -> str:
        return self.code


class RolePermission(UUIDModel):
    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name="role_permissions")
    permission = models.ForeignKey(Permission, on_delete=models.PROTECT, related_name="role_permissions")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "role_permissions"
        constraints = [models.UniqueConstraint(fields=["role", "permission"], name="uq_role_permission")]


class ScopeType(models.TextChoices):
    ORGANIZATION = "organization"
    COMPANY = "company"
    BRANCH = "branch"
    DEPARTMENT = "department"
    FACILITY = "facility"
    WAREHOUSE = "warehouse"


class RoleAssignment(AuthzResourceMixin, ActorStampedModel):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="role_assignments")
    role = models.ForeignKey(Role, on_delete=models.PROTECT, related_name="assignments")
    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    scope_type = models.CharField(max_length=20, choices=ScopeType.choices)
    scope_id = models.UUIDField()
    # Denormalised for scope filtering of assignments themselves (company admins see their company's grants).
    company = models.ForeignKey(
        "organization.Company", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    include_descendants = models.BooleanField(default=True)
    valid_from = models.DateTimeField(null=True, blank=True)
    valid_until = models.DateTimeField(null=True, blank=True)
    reason = models.CharField(max_length=300, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    authz_resource_type = "authorization.role_assignment"
    authz_scope_fields = {"organization": "organization_id", "company": "company_id"}

    class Meta:
        db_table = "role_assignments"
        constraints = [
            models.CheckConstraint(
                condition=Q(scope_type__in=[c.value for c in ScopeType]), name="ck_role_assignment_scope_type"
            ),
            models.CheckConstraint(
                condition=Q(valid_until__isnull=True) | Q(valid_from__isnull=True) | Q(valid_until__gt=F("valid_from")),
                name="ck_role_assignment_validity",
            ),
        ]
        indexes = [
            models.Index(fields=["user"], name="ix_role_assignment_active_user", condition=Q(revoked_at__isnull=True)),
            models.Index(fields=["scope_type", "scope_id"], name="ix_role_assignment_scope"),
        ]


class AbacPolicy(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    class Effect(models.TextChoices):
        ALLOW = "allow"
        DENY = "deny"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    code = models.CharField(max_length=80)
    description = models.TextField(blank=True)
    effect = models.CharField(max_length=5, choices=Effect.choices)
    priority = models.IntegerField(default=100)
    actions = ArrayField(models.CharField(max_length=150), default=list)
    resource_types = ArrayField(models.CharField(max_length=100), default=list, blank=True)
    condition = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=False)
    is_template = models.BooleanField(default=False)

    authz_resource_type = "authorization.policy"
    authz_scope_fields = {"organization": "organization_id"}

    class Meta:
        db_table = "abac_policies"
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uq_abac_policy_org_code"),
            models.CheckConstraint(condition=Q(effect__in=["allow", "deny"]), name="ck_abac_policy_effect"),
        ]


class SodRule(AuthzResourceMixin, ActorStampedModel):
    class Mode(models.TextChoices):
        SAME_USER_SAME_RECORD = "same_user_same_record"
        SAME_USER_ANY = "same_user_any"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    code = models.CharField(max_length=80)
    description = models.TextField(blank=True)
    permission_a = models.ForeignKey(Permission, on_delete=models.PROTECT, related_name="+")
    permission_b = models.ForeignKey(Permission, on_delete=models.PROTECT, related_name="+")
    mode = models.CharField(max_length=30, choices=Mode.choices)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "authorization.sod_rule"
    authz_scope_fields = {"organization": "organization_id"}

    class Meta:
        db_table = "sod_rules"
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uq_sod_rule_org_code"),
            models.CheckConstraint(condition=~Q(permission_a=F("permission_b")), name="ck_sod_rule_distinct"),
            models.CheckConstraint(
                condition=Q(mode__in=["same_user_same_record", "same_user_any"]), name="ck_sod_rule_mode"
            ),
        ]


class ApprovalLimit(AuthzResourceMixin, ActorStampedModel):
    """Maximum amount a role may approve for a document type. No row means no approval authority."""

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    company = models.ForeignKey(
        "organization.Company", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name="approval_limits")
    document_type = models.CharField(max_length=100)
    currency = models.CharField(max_length=3, default="INR")
    max_amount = MoneyField()
    is_active = models.BooleanField(default=True)

    authz_resource_type = "authorization.approval_limit"
    authz_scope_fields = {"organization": "organization_id"}

    class Meta:
        db_table = "approval_limits"
        constraints = [
            models.CheckConstraint(condition=Q(max_amount__gte=0), name="ck_approval_limit_non_negative"),
            # Two partial constraints instead of NULLS NOT DISTINCT (PostgreSQL 15+ only).
            models.UniqueConstraint(
                fields=["role", "document_type", "currency", "company"],
                name="uq_approval_limit_company",
                condition=Q(company__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["role", "document_type", "currency"],
                name="uq_approval_limit_all_companies",
                condition=Q(company__isnull=True),
            ),
        ]
