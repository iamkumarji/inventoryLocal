from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.approvals import registry
from apps.approvals.models import ApprovalDelegation, ApprovalLevel, ApprovalMatrix, ApprovalRequest, ApprovalStep
from apps.authorization.models import Role
from apps.identity.models import User
from apps.organization.models import Company


@extend_schema_field(OpenApiTypes.UUID)
class OrgRoleField(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get("request")
        if request is None:
            return Role.objects.none()
        return Role.objects.filter(organization_id=request.user.organization_id, is_active=True)


@extend_schema_field(OpenApiTypes.UUID)
class OrgUserField(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get("request")
        if request is None:
            return User.objects.none()
        return User.objects.filter(organization_id=request.user.organization_id, is_active=True)


class UserBriefSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "full_name", "email"]
        read_only_fields = fields


class LevelSerializer(serializers.ModelSerializer):
    role = OrgRoleField()
    escalation_role = OrgRoleField(required=False, allow_null=True)
    role_code = serializers.CharField(source="role.code", read_only=True)

    class Meta:
        model = ApprovalLevel
        fields = [
            "id",
            "sequence",
            "name",
            "role",
            "role_code",
            "min_amount",
            "condition",
            "escalation_hours",
            "escalation_role",
        ]
        read_only_fields = ["id", "role_code"]


class MatrixSerializer(serializers.ModelSerializer):
    levels = LevelSerializer(many=True)
    company = serializers.PrimaryKeyRelatedField(queryset=Company.objects.all(), required=False, allow_null=True)

    class Meta:
        model = ApprovalMatrix
        fields = [
            "id",
            "document_type",
            "company",
            "name",
            "description",
            "is_active",
            "levels",
            "version",
            "updated_at",
        ]
        read_only_fields = ["id", "version", "updated_at"]
        validators: list = []

    def validate_document_type(self, value):
        if registry.get(value) is None:
            raise serializers.ValidationError("Unknown document type. See /approvals/document-types/.")
        return value


class MatrixUpdateSerializer(MatrixSerializer):
    version = serializers.IntegerField()

    class Meta(MatrixSerializer.Meta):
        read_only_fields = ["id", "updated_at", "document_type", "company"]


class StepSerializer(serializers.ModelSerializer):
    role_code = serializers.CharField(source="role.code", read_only=True)
    role_name = serializers.CharField(source="role.name", read_only=True)
    decided_by = UserBriefSerializer(read_only=True)
    acting_for = UserBriefSerializer(read_only=True)

    class Meta:
        model = ApprovalStep
        fields = [
            "id",
            "sequence",
            "name",
            "role_code",
            "role_name",
            "is_final",
            "status",
            "decided_by",
            "acting_for",
            "decided_at",
            "comment",
            "due_at",
            "escalated_at",
        ]
        read_only_fields = fields


class RequestSerializer(serializers.ModelSerializer):
    requested_by = UserBriefSerializer(read_only=True)
    document_label = serializers.SerializerMethodField()
    steps = StepSerializer(many=True, read_only=True)
    can_decide = serializers.SerializerMethodField()

    class Meta:
        model = ApprovalRequest
        fields = [
            "id",
            "document_type",
            "document_label",
            "document_id",
            "document_number",
            "title",
            "amount",
            "currency",
            "summary",
            "status",
            "current_sequence",
            "requested_by",
            "submitted_at",
            "completed_at",
            "company",
            "steps",
            "can_decide",
            "version",
        ]
        read_only_fields = fields

    def get_document_label(self, obj) -> str:
        doc_type = registry.get(obj.document_type)
        return doc_type.label if doc_type else obj.document_type

    def get_can_decide(self, obj) -> bool:
        return obj.pk in self.context.get("decidable_ids", set())


class RequestListSerializer(RequestSerializer):
    current_step_name = serializers.SerializerMethodField()

    class Meta(RequestSerializer.Meta):
        fields = [f for f in RequestSerializer.Meta.fields if f != "steps"] + ["current_step_name"]
        read_only_fields = fields

    def get_current_step_name(self, obj) -> str | None:
        step = next((s for s in obj.steps.all() if s.sequence == obj.current_sequence), None)
        return step.name if step else None


class DecisionSerializer(serializers.Serializer):
    comment = serializers.CharField(required=False, allow_blank=True, default="", max_length=2000)
    version = serializers.IntegerField()


class DelegationSerializer(serializers.ModelSerializer):
    delegate = OrgUserField()
    delegator_detail = UserBriefSerializer(source="delegator", read_only=True)
    delegate_detail = UserBriefSerializer(source="delegate", read_only=True)
    is_active = serializers.SerializerMethodField()

    class Meta:
        model = ApprovalDelegation
        fields = [
            "id",
            "delegate",
            "delegate_detail",
            "delegator_detail",
            "document_types",
            "valid_from",
            "valid_until",
            "reason",
            "revoked_at",
            "is_active",
            "created_at",
        ]
        read_only_fields = ["id", "delegator_detail", "delegate_detail", "revoked_at", "is_active", "created_at"]

    def get_is_active(self, obj) -> bool:
        from django.utils import timezone

        now = timezone.now()
        return obj.revoked_at is None and obj.valid_from <= now < obj.valid_until
