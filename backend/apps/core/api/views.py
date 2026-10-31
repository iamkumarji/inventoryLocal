from django.core.cache import cache
from django.db import connection
from django.http import JsonResponse
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import mixins, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit import services as audit
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet, ERPReadOnlyViewSet
from apps.authorization.snapshot import get_snapshot
from apps.core import flags
from apps.core.models import FeatureFlag, OutboxEvent


def health_live(request):
    return JsonResponse({"status": "ok"})


def health_ready(request):
    checks = {}
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        checks["database"] = "ok"
    except Exception:  # noqa: BLE001
        checks["database"] = "error"
    try:
        cache.set("health:ping", "1", 5)
        checks["cache"] = "ok" if cache.get("health:ping") == "1" else "error"
    except Exception:  # noqa: BLE001
        checks["cache"] = "error"
    healthy = all(v == "ok" for v in checks.values())
    return JsonResponse({"status": "ok" if healthy else "degraded", "checks": checks}, status=200 if healthy else 503)


class EffectiveFlagsView(APIView):
    authz_authenticated_only = True

    @extend_schema(responses=inline_serializer("EffectiveFlags", {"flags": serializers.DictField()}), tags=["meta"])
    def get(self, request):
        ctx = actor_for(request)
        snapshot = get_snapshot(request.user.pk)
        return Response(
            {
                "flags": flags.effective_flags(
                    user_id=request.user.pk, role_codes=snapshot.role_codes, company_id=ctx.company_id
                )
            }
        )


class FeatureFlagSerializer(serializers.ModelSerializer):
    class Meta:
        model = FeatureFlag
        fields = ["id", "key", "description", "enabled_default", "rules", "updated_at"]
        read_only_fields = ["id", "key", "updated_at"]

    def validate_rules(self, value):
        if not isinstance(value, dict) or set(value) - {"users", "roles", "companies"}:
            raise serializers.ValidationError("Allowed keys: users, roles, companies.")
        for key, mapping in value.items():
            if not isinstance(mapping, dict) or not all(isinstance(v, bool) for v in mapping.values()):
                raise serializers.ValidationError(f"'{key}' must map ids/codes to booleans.")
        return value


class FeatureFlagViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin, ERPGenericViewSet):
    authz_resource = "core.feature_flag"
    authz_actions = {"update": "manage", "partial_update": "manage"}
    queryset = FeatureFlag.objects.order_by("key")
    serializer_class = FeatureFlagSerializer
    pagination_class = None
    http_method_names = ["get", "patch", "head", "options"]

    def perform_update(self, serializer):
        before = {"enabled_default": serializer.instance.enabled_default, "rules": serializer.instance.rules}
        instance = serializer.save(updated_by=self.request.user)
        flags.invalidate()  # take effect now, not after the cache expires
        audit.record(
            "core.feature_flag.updated",
            ctx=self.actor,
            resource_type="core.feature_flag",
            resource_id=instance.pk,
            summary=instance.key,
            changes=audit.diff(before, {"enabled_default": instance.enabled_default, "rules": instance.rules}),
        )


class OutboxEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = OutboxEvent
        fields = [
            "id",
            "event_type",
            "aggregate_type",
            "aggregate_id",
            "company_id",
            "status",
            "attempts",
            "next_attempt_at",
            "last_error",
            "occurred_at",
            "published_at",
            "request_id",
        ]
        read_only_fields = fields


class OutboxEventViewSet(ERPReadOnlyViewSet):
    """Operational view of the outbox (dead letters can be retried)."""

    authz_resource = "core.outbox_event"
    authz_actions = {"retry": "manage"}
    queryset = OutboxEvent.objects.order_by("-occurred_at")
    serializer_class = OutboxEventSerializer
    filterset_fields = ["status", "event_type", "aggregate_type", "aggregate_id"]

    @extend_schema(request=None, responses=OutboxEventSerializer)
    @action(detail=True, methods=["post"])
    def retry(self, request, pk=None):
        from django.utils import timezone

        event = self.get_object()
        if event.status in (OutboxEvent.Status.DEAD, OutboxEvent.Status.FAILED):
            event.status, event.next_attempt_at, event.attempts = OutboxEvent.Status.PENDING, timezone.now(), 0
            event.save(update_fields=["status", "next_attempt_at", "attempts"])
            audit.record(
                "core.outbox_event.retried",
                ctx=self.actor,
                resource_type="core.outbox_event",
                resource_id=event.pk,
                summary=event.event_type,
            )
        return Response(OutboxEventSerializer(event).data)
