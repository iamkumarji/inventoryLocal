from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.authorization.models import AbacPolicy, ApprovalLimit, Permission, Role, RoleAssignment, ScopeType, SodRule
from apps.identity.models import User
from apps.organization.models import Company


class PermissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Permission
        fields = ["id", "code", "module", "resource", "action", "description", "is_sensitive", "requires_mfa"]
        read_only_fields = fields


class RoleSerializer(serializers.ModelSerializer):
    permission_codes = serializers.SerializerMethodField()

    class Meta:
        model = Role
        fields = [
            "id",
            "code",
            "name",
            "description",
            "is_system_template",
            "is_active",
            "max_session_minutes",
            "mfa_required",
            "permission_codes",
            "version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_permission_codes(self, obj) -> list[str]:
        return sorted(rp.permission.code for rp in obj.role_permissions.all())


class RoleCreateSerializer(serializers.Serializer):
    code = serializers.RegexField(r"^[a-z][a-z0-9_]{1,59}$")
    name = serializers.CharField(max_length=150)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    permission_codes = serializers.ListField(child=serializers.CharField(max_length=150), required=False, default=list)
    max_session_minutes = serializers.IntegerField(min_value=5, required=False, allow_null=True)
    mfa_required = serializers.BooleanField(default=False)

    def validate_code(self, value):
        if value.startswith("tpl_"):
            raise serializers.ValidationError("The 'tpl_' prefix is reserved for templates.")
        return value


class RoleUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150, required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    is_active = serializers.BooleanField(required=False)
    max_session_minutes = serializers.IntegerField(min_value=5, required=False, allow_null=True)
    mfa_required = serializers.BooleanField(required=False)
    version = serializers.IntegerField()


class RolePermissionsSerializer(serializers.Serializer):
    permission_codes = serializers.ListField(child=serializers.CharField(max_length=150))
    version = serializers.IntegerField()


class RoleCloneSerializer(serializers.Serializer):
    code = serializers.RegexField(r"^[a-z][a-z0-9_]{1,59}$")
    name = serializers.CharField(max_length=150)


class RoleAssignmentSerializer(serializers.ModelSerializer):
    role_code = serializers.CharField(source="role.code", read_only=True)
    user_email = serializers.CharField(source="user.email", read_only=True)
    is_effective = serializers.SerializerMethodField()

    class Meta:
        model = RoleAssignment
        fields = [
            "id",
            "user",
            "user_email",
            "role",
            "role_code",
            "scope_type",
            "scope_id",
            "company",
            "include_descendants",
            "valid_from",
            "valid_until",
            "reason",
            "revoked_at",
            "revoked_by",
            "is_effective",
            "created_by",
            "created_at",
        ]
        read_only_fields = fields

    def get_is_effective(self, obj) -> bool:
        from django.utils import timezone

        now = timezone.now()
        return (
            obj.revoked_at is None
            and (obj.valid_from is None or obj.valid_from <= now)
            and (obj.valid_until is None or obj.valid_until > now)
        )


@extend_schema_field(OpenApiTypes.UUID)
class _OrgScoped(serializers.PrimaryKeyRelatedField):
    def __init__(self, model, **kwargs):
        self.model = model
        super().__init__(**kwargs)

    def get_queryset(self):
        request = self.context.get("request")
        if request is None:
            return self.model.objects.none()
        return self.model.objects.filter(organization_id=request.user.organization_id)


class RoleAssignmentCreateSerializer(serializers.Serializer):
    user = _OrgScoped(User)
    role = _OrgScoped(Role)
    scope_type = serializers.ChoiceField(choices=ScopeType.choices)
    scope_id = serializers.UUIDField()
    include_descendants = serializers.BooleanField(default=True)
    valid_from = serializers.DateTimeField(required=False, allow_null=True)
    valid_until = serializers.DateTimeField(required=False, allow_null=True)
    reason = serializers.CharField(max_length=300)

    def validate(self, attrs):
        if attrs.get("valid_from") and attrs.get("valid_until") and attrs["valid_until"] <= attrs["valid_from"]:
            raise serializers.ValidationError({"valid_until": "Must be after valid_from."})
        return attrs


class RevokeSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=300)


class PolicySerializer(serializers.ModelSerializer):
    class Meta:
        model = AbacPolicy
        fields = [
            "id",
            "code",
            "description",
            "effect",
            "priority",
            "actions",
            "resource_types",
            "condition",
            "is_active",
            "is_template",
            "version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "is_template", "version", "created_at", "updated_at"]


class PolicyWriteSerializer(serializers.Serializer):
    code = serializers.RegexField(r"^[a-z][a-z0-9_]{1,79}$", required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    effect = serializers.ChoiceField(choices=["allow", "deny"], required=False)
    priority = serializers.IntegerField(required=False)
    actions = serializers.ListField(child=serializers.CharField(max_length=150), required=False)
    resource_types = serializers.ListField(child=serializers.CharField(max_length=100), required=False)
    condition = serializers.JSONField(required=False)
    is_active = serializers.BooleanField(required=False)
    version = serializers.IntegerField(required=False)


class SodRuleSerializer(serializers.ModelSerializer):
    permission_a = serializers.SlugRelatedField(slug_field="code", queryset=Permission.objects.filter(is_active=True))
    permission_b = serializers.SlugRelatedField(slug_field="code", queryset=Permission.objects.filter(is_active=True))

    class Meta:
        model = SodRule
        fields = ["id", "code", "description", "permission_a", "permission_b", "mode", "is_active", "created_at"]
        read_only_fields = ["id", "is_active", "created_at"]


class ApprovalLimitSerializer(serializers.ModelSerializer):
    role = _OrgScoped(Role)
    company = serializers.PrimaryKeyRelatedField(queryset=Company.objects.all(), required=False, allow_null=True)

    class Meta:
        model = ApprovalLimit
        fields = ["id", "role", "company", "document_type", "currency", "max_amount", "is_active", "updated_at"]
        read_only_fields = ["id", "is_active", "updated_at"]
        validators: list = []  # the service upserts on (role, document_type, currency, company)


class CheckSerializer(serializers.Serializer):
    user = _OrgScoped(User)
    action = serializers.CharField(max_length=150)
    company_id = serializers.UUIDField(required=False, allow_null=True)
    resource_type = serializers.CharField(max_length=100, required=False)
    resource_attributes = serializers.DictField(required=False, default=dict)
    mfa_verified = serializers.BooleanField(default=True)
