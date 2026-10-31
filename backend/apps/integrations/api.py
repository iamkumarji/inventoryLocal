from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import mixins, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter

from apps.authorization.drf import ERPGenericViewSet
from apps.organization.models import Company

from . import services
from .models import WebhookDelivery, WebhookEndpoint


class WebhookEndpointSerializer(serializers.ModelSerializer):
    class Meta:
        model = WebhookEndpoint
        fields = ["id", "version", "name", "url", "company", "event_types", "is_active", "created_at", "updated_at"]
        read_only_fields = ["id", "version", "created_at", "updated_at"]


class WebhookCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    url = serializers.URLField(max_length=500)
    event_types = serializers.ListField(child=serializers.CharField(max_length=150), allow_empty=False)
    company = serializers.PrimaryKeyRelatedField(queryset=Company.objects.all(), required=False, allow_null=True)


class WebhookUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, required=False)
    url = serializers.URLField(max_length=500, required=False)
    event_types = serializers.ListField(child=serializers.CharField(max_length=150), required=False)
    is_active = serializers.BooleanField(required=False)
    version = serializers.IntegerField()


SECRET = inline_serializer(
    "WebhookSecret", {"endpoint": WebhookEndpointSerializer(), "secret": serializers.CharField()}
)


class WebhookDeliverySerializer(serializers.ModelSerializer):
    class Meta:
        model = WebhookDelivery
        fields = [
            "id",
            "endpoint",
            "event_id",
            "event_type",
            "status",
            "attempts",
            "next_attempt_at",
            "last_status_code",
            "last_error",
            "delivered_at",
            "created_at",
            "body",
        ]
        read_only_fields = fields


class WebhookEndpointViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = services.WEBHOOK
    authz_actions = {"rotate_secret": "manage", "test": "manage", "deliveries": "read", "redeliver": "manage"}
    queryset = WebhookEndpoint.objects.order_by("name")
    serializer_class = WebhookEndpointSerializer
    filterset_fields = ["is_active", "company"]

    def get_queryset(self):
        return super().get_queryset().filter(organization_id=self.request.user.organization_id)

    @extend_schema(request=WebhookCreateSerializer, responses={201: SECRET})
    def create(self, request):
        data = WebhookCreateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        endpoint, secret = services.create_endpoint(
            self.actor, organization=request.user.organization, **data.validated_data
        )
        # The signing secret is returned once, here; afterwards it can only be rotated.
        return Response({"endpoint": WebhookEndpointSerializer(endpoint).data, "secret": secret}, status=201)

    @extend_schema(request=WebhookUpdateSerializer, responses=WebhookEndpointSerializer)
    def partial_update(self, request, pk=None):
        data = WebhookUpdateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = dict(data.validated_data)
        version = v.pop("version")
        endpoint = services.update_endpoint(self.actor, self.get_object(), expected_version=version, **v)
        return Response(WebhookEndpointSerializer(endpoint).data)

    @extend_schema(request=None, responses=SECRET)
    @action(detail=True, methods=["post"], url_path="rotate-secret")
    def rotate_secret(self, request, pk=None):
        endpoint = self.get_object()
        secret = services.rotate_secret(self.actor, endpoint)
        endpoint.refresh_from_db()
        return Response({"endpoint": WebhookEndpointSerializer(endpoint).data, "secret": secret})

    @extend_schema(request=None, responses={201: WebhookDeliverySerializer})
    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        return Response(WebhookDeliverySerializer(services.send_test(self.actor, self.get_object())).data, status=201)

    @extend_schema(responses=WebhookDeliverySerializer(many=True))
    @action(detail=True, methods=["get"])
    def deliveries(self, request, pk=None):
        endpoint = self.get_object()
        page = self.paginate_queryset(endpoint.deliveries.order_by("-created_at"))
        return self.get_paginated_response(WebhookDeliverySerializer(page, many=True).data)

    @extend_schema(request=None, responses=WebhookDeliverySerializer)
    @action(detail=True, methods=["post"], url_path=r"deliveries/(?P<delivery_id>[0-9a-fA-F-]{32,36})/redeliver")
    def redeliver(self, request, pk=None, delivery_id=None):
        endpoint = self.get_object()
        delivery = endpoint.deliveries.filter(pk=delivery_id).first()
        if delivery is None:
            from apps.core.exceptions import NotFound

            raise NotFound()
        return Response(WebhookDeliverySerializer(services.redeliver(self.actor, delivery)).data)


router = SimpleRouter()
router.register("integrations/webhooks", WebhookEndpointViewSet, basename="webhook")
urlpatterns = router.urls
