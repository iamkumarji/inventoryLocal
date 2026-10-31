from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter

from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.core.idempotency import idempotent
from apps.logistics import services
from apps.logistics.models import Driver, ProofOfDelivery, Shipment, Vehicle
from apps.organization.models import Branch, Company
from apps.sales.models import Delivery
from apps.shared.docviews import DocumentViewSet
from apps.shared.viewsets import MasterDataViewSet, master_schema


class VehicleSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="logistics.vehicle.read")

    class Meta:
        model = Vehicle
        fields = [
            "id",
            "version",
            "company",
            "branch",
            "registration",
            "vehicle_type",
            "capacity_kg",
            "ownership",
            "insurance_expires_on",
            "permit_expires_on",
            "fitness_expires_on",
            "puc_expires_on",
            "is_active",
        ]
        read_only_fields = ["id", "version"]
        validators: list = []


class DriverSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="logistics.driver.read")

    class Meta:
        model = Driver
        fields = [
            "id",
            "version",
            "company",
            "branch",
            "user",
            "name",
            "phone",
            "licence_number",
            "licence_expires_on",
            "is_active",
        ]
        read_only_fields = ["id", "version"]
        validators: list = []


class PodSerializer(serializers.ModelSerializer):
    delivery = serializers.PrimaryKeyRelatedField(queryset=Delivery.objects.filter(status="posted"))

    class Meta:
        model = ProofOfDelivery
        fields = [
            "id",
            "delivery",
            "outcome",
            "received_by_name",
            "received_at",
            "latitude",
            "longitude",
            "signature_document_id",
            "photo_document_id",
            "remarks",
            "recorded_by",
            "recorded_at",
        ]
        read_only_fields = ["id", "recorded_by", "recorded_at"]


class ShipmentSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="logistics.shipment.read")
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.all())
    deliveries = serializers.PrimaryKeyRelatedField(
        queryset=Delivery.objects.filter(status="posted"), many=True, required=False
    )
    proofs = PodSerializer(many=True, read_only=True)

    class Meta:
        model = Shipment
        fields = [
            "id",
            "number",
            "status",
            "version",
            "company",
            "branch",
            "direction",
            "vehicle",
            "driver",
            "carrier_name",
            "lr_number",
            "planned_date",
            "dispatched_at",
            "completed_at",
            "freight_cost",
            "deliveries",
            "proofs",
        ]
        read_only_fields = ["id", "number", "status", "version", "dispatched_at", "completed_at"]


@master_schema
class VehicleViewSet(MasterDataViewSet):
    authz_resource = "logistics.vehicle"
    authz_actions = {"expiring": "read"}
    queryset = Vehicle.objects.all()
    serializer_class = VehicleSerializer
    editable_fields = (
        "vehicle_type",
        "capacity_kg",
        "ownership",
        "insurance_expires_on",
        "permit_expires_on",
        "fitness_expires_on",
        "puc_expires_on",
        "is_active",
    )
    ordering = ["registration"]
    search_fields = ["registration"]

    @extend_schema(
        parameters=[OpenApiParameter("within_days", int)],
        responses=inline_serializer("ExpiringDocument", {"expires_on": serializers.DateField()}, many=True),
    )
    @action(detail=False, methods=["get"], pagination_class=None)
    def expiring(self, request):
        return Response(
            services.expiring_documents(self.actor.company_id, int(request.query_params.get("within_days", 30)))
        )


@master_schema
class DriverViewSet(MasterDataViewSet):
    authz_resource = "logistics.driver"
    queryset = Driver.objects.all()
    serializer_class = DriverSerializer
    editable_fields = ("phone", "licence_expires_on", "user", "is_active")
    ordering = ["name"]


class ShipmentViewSet(DocumentViewSet):
    authz_resource = services.SHIPMENT
    authz_actions = {"dispatch_shipment": "dispatch", "proof": "deliver"}
    queryset = (
        Shipment.objects.select_related("vehicle", "driver")
        .prefetch_related("deliveries", "proofs")
        .order_by("-planned_date")
    )
    serializer_class = ShipmentSerializer
    filterset_fields = ["status", "direction", "vehicle", "driver", "branch"]

    def create(self, request):
        return self.respond(services.plan_shipment(self.actor, **dict(self.validated())), created=True)

    @extend_schema(request=None, responses=ShipmentSerializer)
    @action(detail=True, methods=["post"], url_path="dispatch")
    def dispatch_shipment(self, request, pk=None):
        return self.respond(services.dispatch(self.actor, self.get_object()))

    @extend_schema(request=PodSerializer, responses=ShipmentSerializer)
    @action(detail=True, methods=["post"])
    @idempotent()
    def proof(self, request, pk=None):
        shipment = self.get_object()
        services.record_proof(self.actor, shipment, **dict(self.validated(PodSerializer)))
        return self.respond(shipment)


router = SimpleRouter()
router.register("logistics/vehicles", VehicleViewSet, basename="vehicle")
router.register("logistics/drivers", DriverViewSet, basename="driver")
router.register("logistics/shipments", ShipmentViewSet, basename="shipment")
urlpatterns = router.urls
