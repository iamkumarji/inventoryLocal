from django.db.models import Prefetch, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view, inline_serializer
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.approvals import registry, services
from apps.approvals.models import ApprovalDelegation, ApprovalMatrix, ApprovalRequest, ApprovalStep
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet
from apps.core.idempotency import idempotent

from . import serializers as s

IDEMPOTENCY_HEADER = OpenApiParameter(
    "Idempotency-Key",
    str,
    OpenApiParameter.HEADER,
    required=True,
    description="Unique per user action; retries with the same key replay the stored response.",
)

STEPS_PREFETCH = Prefetch(
    "steps", queryset=ApprovalStep.objects.select_related("role", "decided_by", "acting_for").order_by("sequence")
)


class DocumentTypesView(APIView):
    authz_authenticated_only = True

    @extend_schema(
        responses=inline_serializer(
            "DocumentType", {"code": serializers.CharField(), "label": serializers.CharField()}, many=True
        )
    )
    def get(self, request):
        return Response([{"code": d.code, "label": d.label} for d in registry.all_types()])


class InboxView(APIView):
    """Requests awaiting a decision from the caller (directly or as a delegate)."""

    authz_authenticated_only = True

    @extend_schema(responses=s.RequestListSerializer(many=True))
    def get(self, request):
        items = services.inbox(actor_for(request))
        ids = {r.pk for r in items}
        qs = (
            ApprovalRequest.objects.filter(pk__in=ids)
            .select_related("requested_by")
            .prefetch_related(STEPS_PREFETCH)
            .order_by("submitted_at")
        )
        return Response(s.RequestListSerializer(qs, many=True, context={"decidable_ids": ids}).data)


class InboxCountView(APIView):
    authz_authenticated_only = True

    @extend_schema(responses=inline_serializer("InboxCount", {"count": serializers.IntegerField()}))
    def get(self, request):
        return Response({"count": len(services.inbox(actor_for(request)))})


@extend_schema_view(
    list=extend_schema(parameters=[OpenApiParameter("mine", OpenApiTypes.BOOL, description="Only my requests")])
)
class ApprovalRequestViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    """Requests visible to the caller: own, decided, awaiting them, or oversight within scope."""

    authz_authenticated_only = True
    serializer_class = s.RequestSerializer
    filterset_fields = ["status", "document_type"]
    search_fields = ["title", "document_number"]
    ordering_fields = ["submitted_at", "amount"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return ApprovalRequest.objects.none()
        ctx = self.actor
        self._inbox_ids = {r.pk for r in services.inbox(ctx)}
        qs = ApprovalRequest.objects.filter(services.visible_requests_q(ctx, list(self._inbox_ids))).distinct()
        if self.request.query_params.get("mine") in ("1", "true"):
            qs = qs.filter(requested_by=self.request.user)
        if ctx.company_id:
            qs = qs.filter(company_id=ctx.company_id)
        return qs.select_related("requested_by").prefetch_related(STEPS_PREFETCH).order_by("-submitted_at")

    def get_serializer_class(self):
        return s.RequestListSerializer if self.action == "list" else s.RequestSerializer

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["decidable_ids"] = getattr(self, "_inbox_ids", set())
        return context

    def _decide(self, request, approve: bool):
        approval = self.get_object()
        data = s.DecisionSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        services.decide(
            self.actor,
            approval,
            approve=approve,
            comment=data.validated_data["comment"],
            expected_version=data.validated_data["version"],
        )
        fresh = self.get_queryset().get(pk=approval.pk)
        return Response(s.RequestSerializer(fresh, context=self.get_serializer_context()).data)

    @extend_schema(request=s.DecisionSerializer, responses=s.RequestSerializer, parameters=[IDEMPOTENCY_HEADER])
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def approve(self, request, pk=None):
        return self._decide(request, approve=True)

    @extend_schema(request=s.DecisionSerializer, responses=s.RequestSerializer, parameters=[IDEMPOTENCY_HEADER])
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def reject(self, request, pk=None):
        return self._decide(request, approve=False)

    @extend_schema(request=s.DecisionSerializer, responses=s.RequestSerializer)
    @action(detail=True, methods=["post"])
    def withdraw(self, request, pk=None):
        approval = self.get_object()
        data = s.DecisionSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        services.withdraw(
            self.actor, approval, reason=data.validated_data["comment"], expected_version=data.validated_data["version"]
        )
        return Response(
            s.RequestSerializer(self.get_queryset().get(pk=approval.pk), context=self.get_serializer_context()).data
        )


class ApprovalMatrixViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "approvals.approval_matrix"
    authz_actions = {"create": "manage", "partial_update": "manage"}
    queryset = ApprovalMatrix.objects.prefetch_related("levels__role").order_by("document_type", "name")
    serializer_class = s.MatrixSerializer
    filterset_fields = ["document_type", "company", "is_active"]

    @extend_schema(request=s.MatrixSerializer, responses={201: s.MatrixSerializer})
    def create(self, request):
        data = s.MatrixSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        matrix = services.save_matrix(
            self.actor, organization=request.user.organization, data=dict(data.validated_data)
        )
        return Response(
            s.MatrixSerializer(matrix, context=self.get_serializer_context()).data, status=status.HTTP_201_CREATED
        )

    @extend_schema(request=s.MatrixUpdateSerializer, responses=s.MatrixSerializer)
    def partial_update(self, request, pk=None):
        matrix = self.get_object()
        data = s.MatrixUpdateSerializer(data=request.data, partial=True, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        values = dict(data.validated_data)
        version = values.pop("version", None)
        matrix = services.save_matrix(
            self.actor, organization=request.user.organization, data=values, matrix=matrix, expected_version=version
        )
        return Response(
            s.MatrixSerializer(ApprovalMatrix.objects.get(pk=matrix.pk), context=self.get_serializer_context()).data
        )


class DelegationViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, ERPGenericViewSet):
    """The caller's delegations, given or received (self-service)."""

    authz_authenticated_only = True
    serializer_class = s.DelegationSerializer
    pagination_class = None

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return ApprovalDelegation.objects.none()
        user = self.request.user
        return (
            ApprovalDelegation.objects.filter(Q(delegator=user) | Q(delegate=user))
            .select_related("delegator", "delegate")
            .order_by("-created_at")
        )

    def create(self, request):
        data = s.DelegationSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        delegation = services.create_delegation(self.actor, **data.validated_data)
        return Response(s.DelegationSerializer(delegation).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=None, responses=s.DelegationSerializer)
    @action(detail=True, methods=["post"])
    def revoke(self, request, pk=None):
        delegation = services.revoke_delegation(self.actor, self.get_object())
        return Response(s.DelegationSerializer(delegation).data)
