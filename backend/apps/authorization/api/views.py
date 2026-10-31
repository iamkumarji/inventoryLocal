from uuid import UUID

from django.db.models import Prefetch
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view, inline_serializer
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization import pdp, services
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet, ERPReadOnlyViewSet
from apps.authorization.models import (
    AbacPolicy,
    ApprovalLimit,
    Permission,
    Role,
    RoleAssignment,
    RolePermission,
    SodRule,
)
from apps.core.context import ActorContext
from apps.core.idempotency import idempotency_header, idempotent

from . import serializers as s


class PermissionViewSet(ERPReadOnlyViewSet):
    authz_resource = "authorization.permission"
    queryset = Permission.objects.filter(is_active=True).order_by("code")
    serializer_class = s.PermissionSerializer
    filterset_fields = ["module", "resource", "action", "is_sensitive", "requires_mfa"]
    search_fields = ["code", "description"]
    pagination_class = None


class RoleViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "authorization.role"
    authz_actions = {"set_permissions": "manage", "clone": "create"}
    queryset = Role.objects.prefetch_related(
        Prefetch("role_permissions", queryset=RolePermission.objects.select_related("permission"))
    ).order_by("code")
    serializer_class = s.RoleSerializer
    filterset_fields = ["is_active", "is_system_template"]
    search_fields = ["code", "name"]

    @extend_schema(request=s.RoleCreateSerializer, responses={201: s.RoleSerializer})
    def create(self, request):
        data = s.RoleCreateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        role = services.create_role(self.actor, organization=request.user.organization, **data.validated_data)
        return Response(s.RoleSerializer(self.get_queryset().get(pk=role.pk)).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=s.RoleUpdateSerializer, responses=s.RoleSerializer)
    def partial_update(self, request, pk=None):
        role = self.get_object()
        data = s.RoleUpdateSerializer(data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        values = dict(data.validated_data)
        version = values.pop("version", None)
        role = services.update_role(self.actor, role, values, version)
        return Response(s.RoleSerializer(self.get_queryset().get(pk=role.pk)).data)

    @extend_schema(request=s.RolePermissionsSerializer, responses=s.RoleSerializer)
    @action(detail=True, methods=["put"], url_path="permissions")
    def set_permissions(self, request, pk=None):
        role = self.get_object()
        data = s.RolePermissionsSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        role = services.set_role_permissions(
            self.actor, role, data.validated_data["permission_codes"], data.validated_data["version"]
        )
        return Response(s.RoleSerializer(self.get_queryset().get(pk=role.pk)).data)

    @extend_schema(request=s.RoleCloneSerializer, responses={201: s.RoleSerializer})
    @action(detail=True, methods=["post"])
    def clone(self, request, pk=None):
        source = self.get_object()
        data = s.RoleCloneSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        role = services.clone_role(self.actor, source, **data.validated_data)
        return Response(s.RoleSerializer(self.get_queryset().get(pk=role.pk)).data, status=status.HTTP_201_CREATED)


@extend_schema_view(
    list=extend_schema(
        parameters=[OpenApiParameter("active", OpenApiTypes.BOOL, description="Only effective assignments")]
    )
)
class RoleAssignmentViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "authorization.role_assignment"
    authz_actions = {"create": "assign", "revoke": "assign"}
    queryset = RoleAssignment.objects.select_related("role", "user").order_by("-created_at")
    serializer_class = s.RoleAssignmentSerializer
    filterset_fields = ["user", "role", "scope_type", "scope_id", "company"]

    def get_queryset(self):
        queryset = super().get_queryset()
        if self.request.query_params.get("active") in ("1", "true"):
            now = timezone.now()
            queryset = queryset.filter(revoked_at__isnull=True).exclude(valid_until__lte=now)
        return queryset

    @extend_schema(
        request=s.RoleAssignmentCreateSerializer,
        responses={201: s.RoleAssignmentSerializer},
        parameters=[idempotency_header()],
    )
    @idempotent()
    def create(self, request):
        data = s.RoleAssignmentCreateSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        assignment = services.assign_role(self.actor, **data.validated_data)
        return Response(s.RoleAssignmentSerializer(assignment).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=s.RevokeSerializer, responses=s.RoleAssignmentSerializer)
    @action(detail=True, methods=["post"])
    def revoke(self, request, pk=None):
        assignment = self.get_object()
        data = s.RevokeSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        assignment = services.revoke_assignment(self.actor, assignment, data.validated_data["reason"])
        return Response(s.RoleAssignmentSerializer(assignment).data)


class PolicyViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "authorization.policy"
    authz_actions = {"create": "manage", "partial_update": "manage", "validate": "read"}
    queryset = AbacPolicy.objects.order_by("priority", "code")
    serializer_class = s.PolicySerializer
    filterset_fields = ["effect", "is_active", "is_template"]

    @extend_schema(request=s.PolicyWriteSerializer, responses={201: s.PolicySerializer})
    def create(self, request):
        data = s.PolicyWriteSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        values = dict(data.validated_data)
        values.pop("version", None)
        policy = services.save_policy(self.actor, organization=request.user.organization, data=values)
        return Response(s.PolicySerializer(policy).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=s.PolicyWriteSerializer, responses=s.PolicySerializer)
    def partial_update(self, request, pk=None):
        policy = self.get_object()
        data = s.PolicyWriteSerializer(data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        values = dict(data.validated_data)
        version = values.pop("version", None)
        values.pop("code", None)
        merged = {f: getattr(policy, f) for f in services.POLICY_FIELDS} | values
        policy = services.save_policy(
            self.actor, organization=request.user.organization, data=merged, policy=policy, expected_version=version
        )
        return Response(s.PolicySerializer(policy).data)

    @extend_schema(
        request=s.PolicyWriteSerializer,
        responses=inline_serializer(
            "PolicyValidation", {"valid": serializers.BooleanField(), "errors": serializers.ListField()}
        ),
    )
    @action(detail=False, methods=["post"])
    def validate(self, request):
        errors = services.validate_policy_payload(request.data if isinstance(request.data, dict) else {})
        return Response({"valid": not errors, "errors": errors})


class SodRuleViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "authorization.sod_rule"
    authz_actions = {"create": "manage", "conflicts": "read"}
    queryset = SodRule.objects.select_related("permission_a", "permission_b").order_by("code")
    serializer_class = s.SodRuleSerializer

    @extend_schema(request=s.SodRuleSerializer, responses={201: s.SodRuleSerializer})
    def create(self, request):
        data = s.SodRuleSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        rule = services.create_sod_rule(
            self.actor,
            organization=request.user.organization,
            code=v["code"],
            permission_a=v["permission_a"].code,
            permission_b=v["permission_b"].code,
            mode=v["mode"],
            description=v.get("description", ""),
        )
        return Response(s.SodRuleSerializer(rule).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        responses=inline_serializer(
            "SodConflict", {"user_id": serializers.UUIDField(), "rule": serializers.CharField()}, many=True
        )
    )
    @action(detail=False, methods=["get"], pagination_class=None)
    def conflicts(self, request):
        return Response(services.sod_conflict_report(request.user.organization))


class ApprovalLimitViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "authorization.approval_limit"
    authz_actions = {"create": "manage"}
    queryset = ApprovalLimit.objects.select_related("role").order_by("document_type", "role__code")
    serializer_class = s.ApprovalLimitSerializer
    filterset_fields = ["role", "company", "document_type", "currency", "is_active"]

    @extend_schema(
        request=s.ApprovalLimitSerializer,
        responses={201: s.ApprovalLimitSerializer},
        description="Create or replace the limit for (role, document_type, currency, company).",
    )
    def create(self, request):
        data = s.ApprovalLimitSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        limit = services.set_approval_limit(self.actor, organization=request.user.organization, **data.validated_data)
        return Response(s.ApprovalLimitSerializer(limit).data, status=status.HTTP_201_CREATED)


class CheckView(APIView):
    """Explain an authorization decision for a user (admin diagnostic)."""

    authz_resource = "authorization.policy"
    authz_actions = {"post": "manage"}

    @extend_schema(
        request=s.CheckSerializer,
        responses=inline_serializer(
            "Explain", {"allowed": serializers.BooleanField(), "reason": serializers.CharField()}
        ),
    )
    def post(self, request):
        data = s.CheckSerializer(data=request.data, context={"request": request})
        data.is_valid(raise_exception=True)
        v = data.validated_data
        target = ActorContext(
            user=v["user"],
            company_id=v.get("company_id"),
            client_type="web",
            mfa_verified_at=timezone.now() if v["mfa_verified"] else None,
            request_id=actor_for(request).request_id,
        )
        resource = None
        if v.get("resource_type"):
            attrs = {}
            for key, value in v["resource_attributes"].items():
                if (key == "id" or key.endswith("_id")) and isinstance(value, str):
                    try:
                        value = UUID(value)
                    except ValueError:
                        pass
                attrs[key] = value
            resource = pdp.Resource.ref(v["resource_type"], **attrs)
        return Response(pdp.explain(target, v["action"], resource))
