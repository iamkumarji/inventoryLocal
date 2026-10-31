from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization.context import actor_for
from apps.core.exceptions import NotFound
from apps.organization.models import Organization

from . import services


class OrganizationSummarySerializer(serializers.ModelSerializer):
    users = serializers.IntegerField(source="user_count", read_only=True)
    companies = serializers.IntegerField(source="company_count", read_only=True)

    class Meta:
        model = Organization
        fields = ["id", "code", "name", "is_active", "base_currency", "timezone", "users", "companies", "created_at"]
        read_only_fields = fields


class ProvisionSerializer(serializers.Serializer):
    code = serializers.RegexField(r"^[A-Z0-9][A-Z0-9_-]{1,29}$", help_text="Short code, capitals and digits.")
    name = serializers.CharField(max_length=200)
    company_code = serializers.RegexField(r"^[A-Z0-9][A-Z0-9_-]{1,29}$")
    company_name = serializers.CharField(max_length=200)
    state_code = serializers.CharField(max_length=2, required=False, allow_blank=True, default="")
    gstin = serializers.CharField(max_length=15, required=False, allow_blank=True, default="")
    fiscal_start_year = serializers.IntegerField(required=False, min_value=2000, max_value=2100)
    admin_email = serializers.EmailField()
    admin_name = serializers.CharField(max_length=200)
    admin_password = serializers.CharField(
        min_length=12,
        max_length=128,
        write_only=True,
        help_text="Temporary; the admin must change it at first sign-in.",
    )


class StatusSerializer(serializers.Serializer):
    active = serializers.BooleanField()
    reason = serializers.CharField(max_length=500)


class _PlatformView(APIView):
    """Operator-only: checked in the service layer (is_platform_operator + recent MFA), not by grants,
    because operators deliberately hold no grants inside any organization."""

    authz_authenticated_only = True


class OrganizationsView(_PlatformView):
    @extend_schema(responses=OrganizationSummarySerializer(many=True), tags=["platform"])
    def get(self, request):
        services.require_operator(actor_for(request))
        return Response(OrganizationSummarySerializer(services.overview(), many=True).data)

    @extend_schema(request=ProvisionSerializer, responses={201: OrganizationSummarySerializer}, tags=["platform"])
    def post(self, request):
        ctx = actor_for(request)
        services.require_operator(ctx)
        data = ProvisionSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        result = services.provision_organization(ctx, **data.validated_data)
        row = services.overview([result.organization.pk]).get()
        return Response(OrganizationSummarySerializer(row).data, status=201)


class OrganizationStatusView(_PlatformView):
    @extend_schema(request=StatusSerializer, responses=OrganizationSummarySerializer, tags=["platform"])
    def post(self, request, organization_id):
        ctx = actor_for(request)
        services.require_operator(ctx)
        organization = Organization.objects.filter(pk=organization_id).first()
        if organization is None:
            raise NotFound()
        data = StatusSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        services.set_active(
            ctx, organization, active=data.validated_data["active"], reason=data.validated_data["reason"]
        )
        return Response(OrganizationSummarySerializer(services.overview([organization.pk]).get()).data)


from django.urls import path  # noqa: E402

urlpatterns = [
    path("platform/organizations/", OrganizationsView.as_view(), name="platform-organizations"),
    path(
        "platform/organizations/<uuid:organization_id>/status/",
        OrganizationStatusView.as_view(),
        name="platform-organization-status",
    ),
]
