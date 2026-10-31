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
from apps.core.models import FeatureFlag, OrganizationFeatureFlag, OutboxEvent


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
                    user_id=request.user.pk,
                    role_codes=snapshot.role_codes,
                    company_id=ctx.company_id,
                    organization_id=request.user.organization_id,
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

    # Tenants see and change their own organization's setting (enabled_default/rules in the response are
    # the organization's effective values); the platform default only applies until they choose. Users
    # without an organization (platform operators) edit the platform default.

    def _org_values(self, flag: FeatureFlag) -> dict:
        org_id = self.request.user.organization_id
        own = OrganizationFeatureFlag.objects.filter(organization_id=org_id, key=flag.key).first() if org_id else None
        data = FeatureFlagSerializer(flag).data
        if org_id:
            data["enabled_default"] = own.enabled if own else flag.enabled_default
            data["rules"] = own.rules if own else {}
        return data

    def list(self, request, *args, **kwargs):
        return Response([self._org_values(flag) for flag in self.filter_queryset(self.get_queryset())])

    def retrieve(self, request, *args, **kwargs):
        return Response(self._org_values(self.get_object()))

    def partial_update(self, request, *args, **kwargs):
        flag = self.get_object()
        data = FeatureFlagSerializer(flag, data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        org_id = request.user.organization_id
        values = data.validated_data
        if "rules" in values:
            _check_rule_targets(values["rules"], org_id)
        before = self._org_values(flag)
        if org_id:
            own, _ = OrganizationFeatureFlag.objects.get_or_create(
                organization_id=org_id, key=flag.key, defaults={"enabled": flag.enabled_default}
            )
            own.enabled = values.get("enabled_default", own.enabled)
            own.rules = values.get("rules", own.rules)
            own.updated_by = request.user
            own.save()
        else:
            data.save(updated_by=request.user)
        flags.invalidate()  # take effect now, not after the cache expires
        after = self._org_values(flag)
        audit.record(
            "core.feature_flag.updated",
            ctx=self.actor,
            resource_type="core.feature_flag",
            resource_id=flag.pk,
            organization_id=org_id,
            summary=flag.key if org_id else f"{flag.key} (platform default)",
            changes=audit.diff(
                {"enabled": before["enabled_default"], "rules": before["rules"]},
                {"enabled": after["enabled_default"], "rules": after["rules"]},
            ),
        )
        return Response(after)

    def update(self, request, *args, **kwargs):
        return self.partial_update(request, *args, **kwargs)


def _check_rule_targets(rules: dict, org_id) -> None:
    """Targeting may only name this organization's users and companies."""
    if org_id is None:
        return
    from django.apps import apps

    user_ids = set(rules.get("users", {}))
    company_ids = set(rules.get("companies", {}))
    users = apps.get_model("identity", "User").objects.filter(pk__in=user_ids, organization_id=org_id).count()
    companies = apps.get_model("organization", "Company").objects.filter(pk__in=company_ids, organization_id=org_id)
    if users != len(user_ids) or companies.count() != len(company_ids):
        raise serializers.ValidationError({"rules": ["Target only users and companies of your organization."]})


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

    def get_queryset(self):
        # Events carry a company, not an organization: show only this organization's companies.
        # Events with no company (platform housekeeping) are for platform operators only.
        from django.apps import apps

        org_id = self.request.user.organization_id
        if org_id is None:
            return super().get_queryset().filter(company_id__isnull=True)
        companies = apps.get_model("organization", "Company").objects.filter(organization_id=org_id)
        return super().get_queryset().filter(company_id__in=companies.values("pk"))

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
