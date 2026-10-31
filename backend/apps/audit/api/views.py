import django_filters
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.audit.models import AuditEvent
from apps.audit.services import verify_chain
from apps.authorization.drf import ERPReadOnlyViewSet
from apps.core.pagination import LedgerCursorPagination

from .serializers import AuditEventSerializer


class AuditEventFilter(django_filters.FilterSet):
    occurred_after = django_filters.IsoDateTimeFilter(field_name="occurred_at", lookup_expr="gte")
    occurred_before = django_filters.IsoDateTimeFilter(field_name="occurred_at", lookup_expr="lt")
    action_prefix = django_filters.CharFilter(field_name="action", lookup_expr="startswith")

    class Meta:
        model = AuditEvent
        fields = ["actor_id", "action", "resource_type", "resource_id", "outcome", "company_id", "request_id"]


class AuditEventViewSet(ERPReadOnlyViewSet):
    """Read-only, append-only audit trail. There are no write endpoints by design."""

    authz_resource = "audit.audit_event"
    authz_actions = {"verify_chain": "manage"}
    queryset = AuditEvent.objects.select_related("seal")
    serializer_class = AuditEventSerializer
    pagination_class = LedgerCursorPagination
    filterset_class = AuditEventFilter
    search_fields = ["summary", "actor_label", "action"]
    ordering_fields: list[str] = []

    @extend_schema(
        responses=inline_serializer(
            "ChainVerification", {"valid": serializers.BooleanField(), "checked": serializers.IntegerField()}
        )
    )
    @action(detail=False, methods=["get"], url_path="verify-chain")
    def verify_chain(self, request):
        return Response(verify_chain())
