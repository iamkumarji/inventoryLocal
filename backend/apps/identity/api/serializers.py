from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.authorization.pdp import accessible_company_ids
from apps.identity.models import AuthSession, User
from apps.organization.models import Company


@extend_schema_field(OpenApiTypes.UUID)
class AccessibleCompanyField(serializers.PrimaryKeyRelatedField):
    """Companies in which the caller holds any grant (the PDP still checks the specific action)."""

    def get_queryset(self):
        request = self.context.get("request")
        if request is None:
            return Company.objects.none()
        return Company.objects.filter(pk__in=accessible_company_ids(request.user.pk), is_active=True)


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)
    password = serializers.CharField(max_length=256, trim_whitespace=False)
    client_type = serializers.ChoiceField(choices=["web", "mobile"], required=False, default="web")
    device_id = serializers.CharField(max_length=100, required=False, allow_blank=True)


class MFALoginSerializer(serializers.Serializer):
    challenge_token = serializers.CharField(max_length=200)
    code = serializers.CharField(max_length=20)


class CodeSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=20)


class PasswordChangeSerializer(serializers.Serializer):
    current_password = serializers.CharField(max_length=256, trim_whitespace=False)
    new_password = serializers.CharField(max_length=256, trim_whitespace=False)


class SessionSerializer(serializers.ModelSerializer):
    is_current = serializers.SerializerMethodField()

    class Meta:
        model = AuthSession
        fields = [
            "id",
            "client_type",
            "ip",
            "user_agent",
            "device_id",
            "created_at",
            "last_seen_at",
            "idle_expires_at",
            "absolute_expires_at",
            "mfa_verified_at",
            "is_current",
        ]

    def get_is_current(self, obj) -> bool:
        request = self.context.get("request")
        return bool(request and getattr(request.auth, "pk", None) == obj.pk)


class UserSerializer(serializers.ModelSerializer):
    mfa_enrolled = serializers.SerializerMethodField()
    is_locked = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "full_name",
            "phone",
            "organization",
            "default_company",
            "is_active",
            "mfa_enforced",
            "mfa_enrolled",
            "is_locked",
            "must_change_password",
            "last_login",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_mfa_enrolled(self, obj) -> bool:
        device = getattr(obj, "mfa_device", None)
        return bool(device and device.confirmed_at)

    def get_is_locked(self, obj) -> bool:
        from django.utils import timezone

        return bool(obj.locked_until and obj.locked_until > timezone.now())


class UserCreateSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)
    full_name = serializers.CharField(max_length=200)
    phone = serializers.CharField(max_length=30, required=False, allow_blank=True, default="")
    default_company = AccessibleCompanyField(required=False, allow_null=True)
    mfa_enforced = serializers.BooleanField(default=False)
    temporary_password = serializers.CharField(max_length=256, trim_whitespace=False, write_only=True)


class UserUpdateSerializer(serializers.Serializer):
    full_name = serializers.CharField(max_length=200, required=False)
    phone = serializers.CharField(max_length=30, required=False, allow_blank=True)
    default_company = AccessibleCompanyField(required=False, allow_null=True)
    mfa_enforced = serializers.BooleanField(required=False)
