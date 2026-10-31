from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter

from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.manufacturing import services
from apps.manufacturing.models import (
    Bom,
    BomComponent,
    BomVersion,
    ProductionMaterial,
    ProductionOperation,
    ProductionOrder,
    RoutingOperation,
    WorkCenter,
)
from apps.masterdata.models import Item
from apps.organization.models import Company, Facility, Warehouse
from apps.shared.docviews import DocumentViewSet, ReasonBody
from apps.shared.viewsets import MasterDataViewSet, master_schema


class WorkCenterSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="manufacturing.work_center.read")

    class Meta:
        model = WorkCenter
        fields = [
            "id",
            "version",
            "company",
            "facility",
            "code",
            "name",
            "capacity_hours_per_day",
            "labour_rate",
            "machine_rate",
            "overhead_rate",
            "is_active",
        ]
        read_only_fields = ["id", "version"]
        validators: list = []


class ComponentSerializer(serializers.ModelSerializer):
    item = serializers.PrimaryKeyRelatedField(queryset=Item.objects.filter(is_active=True))
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = BomComponent
        fields = ["id", "line_no", "item", "item_code", "quantity", "scrap_pct", "issue_method"]
        read_only_fields = ["id", "line_no", "item_code"]


class OperationSerializer(serializers.ModelSerializer):
    class Meta:
        model = RoutingOperation
        fields = ["id", "sequence", "name", "work_center_code", "setup_minutes", "run_minutes_per_unit"]
        read_only_fields = ["id"]


class VersionSerializer(serializers.ModelSerializer):
    components = ComponentSerializer(many=True)
    operations = OperationSerializer(many=True, required=False)

    class Meta:
        model = BomVersion
        fields = [
            "id",
            "version_no",
            "status",
            "output_quantity",
            "effective_from",
            "effective_to",
            "approved_by",
            "notes",
            "components",
            "operations",
            "created_by",
            "created_at",
        ]
        read_only_fields = ["id", "version_no", "status", "effective_to", "approved_by", "created_by", "created_at"]


class BomSerializer(serializers.ModelSerializer):
    item = serializers.PrimaryKeyRelatedField(queryset=Item.objects.filter(is_manufactured=True))
    item_code = serializers.CharField(source="item.code", read_only=True)
    versions = VersionSerializer(many=True, read_only=True)

    class Meta:
        model = Bom
        fields = ["id", "version", "item", "item_code", "code", "name", "is_active", "versions"]
        read_only_fields = ["id", "version", "item_code", "versions"]
        validators: list = []


@master_schema
class WorkCenterViewSet(MasterDataViewSet):
    authz_resource = "manufacturing.work_center"
    queryset = WorkCenter.objects.all()
    serializer_class = WorkCenterSerializer
    editable_fields = ("name", "capacity_hours_per_day", "labour_rate", "machine_rate", "overhead_rate", "is_active")
    filterset_fields = ["facility", "is_active"]


@master_schema
class BomViewSet(MasterDataViewSet):
    authz_resource = "manufacturing.bom"
    authz_actions = {"add_version": "update", "approve_version": "approve", "explosion": "read"}
    queryset = Bom.objects.select_related("item").prefetch_related("versions__components__item", "versions__operations")
    serializer_class = BomSerializer
    editable_fields = ("name", "is_active")
    filterset_fields = ["item", "is_active"]
    search_fields = ["code", "name", "item__code"]

    @extend_schema(request=VersionSerializer, responses={201: BomSerializer})
    @action(detail=True, methods=["post"], url_path="versions")
    def add_version(self, request, pk=None):
        bom = self.get_object()
        data = VersionSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = dict(data.validated_data)
        services.create_bom_version(
            self.actor,
            bom,
            effective_from=v["effective_from"],
            output_quantity=v.get("output_quantity", 1),
            components=v["components"],
            operations=v.get("operations", []),
            notes=v.get("notes", ""),
        )
        return Response(BomSerializer(self.get_queryset().get(pk=bom.pk)).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        request=None,
        responses=BomSerializer,
        parameters=[OpenApiParameter("version_id", OpenApiTypes.UUID, OpenApiParameter.PATH)],
    )
    @action(detail=True, methods=["post"], url_path=r"versions/(?P<version_id>[^/.]+)/approve")
    def approve_version(self, request, pk=None, version_id=None):
        bom = self.get_object()
        services.approve_bom_version(self.actor, BomVersion.objects.get(pk=version_id, bom=bom))
        return Response(BomSerializer(self.get_queryset().get(pk=bom.pk)).data)

    @extend_schema(
        parameters=[OpenApiParameter("quantity", str, required=True), OpenApiParameter("on", str)],
        responses=inline_serializer(
            "Explosion", {"tree": serializers.DictField(), "requirements": serializers.DictField()}
        ),
    )
    @action(detail=True, methods=["get"])
    def explosion(self, request, pk=None):
        bom = self.get_object()
        on = serializers.DateField().to_internal_value(request.query_params.get("on") or str(timezone.localdate()))
        qty = serializers.DecimalField(20, 6).to_internal_value(request.query_params.get("quantity", "1"))
        tree = services.explode(bom.item, qty, on)
        return Response({"tree": tree, "requirements": services.flatten(tree)})


class MaterialSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = ProductionMaterial
        fields = [
            "id",
            "item",
            "item_code",
            "required_quantity",
            "per_unit",
            "issue_method",
            "issued_quantity",
            "consumed_quantity",
            "returned_quantity",
        ]
        read_only_fields = fields


class ProdOperationSerializer(serializers.ModelSerializer):
    work_center_code = serializers.CharField(source="work_center.code", read_only=True)

    class Meta:
        model = ProductionOperation
        fields = [
            "id",
            "sequence",
            "name",
            "work_center",
            "work_center_code",
            "planned_minutes",
            "actual_minutes",
            "completed_quantity",
        ]
        read_only_fields = fields


class ProductionOrderSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action=f"{services.PO}.read")
    facility = ScopedPrimaryKeyRelatedField(queryset=Facility.objects.all(), read_action=f"{services.PO}.read")
    item = serializers.PrimaryKeyRelatedField(queryset=Item.objects.filter(is_manufactured=True))
    source_warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.all())
    wip_warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.filter(warehouse_type="wip"))
    output_warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.all())
    item_code = serializers.CharField(source="item.code", read_only=True)
    materials = MaterialSerializer(many=True, read_only=True)
    operations = ProdOperationSerializer(many=True, read_only=True)
    costing = serializers.SerializerMethodField()

    class Meta:
        model = ProductionOrder
        fields = [
            "id",
            "number",
            "kind",
            "status",
            "version",
            "company",
            "facility",
            "item",
            "item_code",
            "bom_version",
            "quantity",
            "planned_start",
            "planned_end",
            "source_warehouse",
            "wip_warehouse",
            "output_warehouse",
            "produced_quantity",
            "scrapped_quantity",
            "materials",
            "operations",
            "costing",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "number",
            "kind",
            "status",
            "version",
            "bom_version",
            "produced_quantity",
            "scrapped_quantity",
            "created_at",
        ]

    def get_costing(self, obj) -> dict:
        return services.costing(obj)


class IssueLine(serializers.Serializer):
    material = serializers.PrimaryKeyRelatedField(queryset=ProductionMaterial.objects.all())
    quantity = serializers.DecimalField(max_digits=20, decimal_places=6, min_value=0)
    batch_number = serializers.CharField(required=False, allow_blank=True, default="")
    serials = serializers.ListField(child=serializers.CharField(), required=False, default=list)


class IssueSerializer(serializers.Serializer):
    on = serializers.DateField()
    lines = IssueLine(many=True)


class ConfirmSerializer(serializers.Serializer):
    operation = serializers.PrimaryKeyRelatedField(queryset=ProductionOperation.objects.all())
    minutes = serializers.DecimalField(max_digits=10, decimal_places=2)
    quantity = serializers.DecimalField(max_digits=20, decimal_places=6, required=False, default=0)


class OutputSerializer(serializers.Serializer):
    on = serializers.DateField()
    quantity = serializers.DecimalField(max_digits=20, decimal_places=6)
    batch_number = serializers.CharField(required=False, allow_blank=True, default="")
    serials = serializers.ListField(child=serializers.CharField(), required=False, default=list)


class ScrapSerializer(serializers.Serializer):
    on = serializers.DateField()
    material = serializers.PrimaryKeyRelatedField(queryset=ProductionMaterial.objects.all())
    quantity = serializers.DecimalField(max_digits=20, decimal_places=6)
    reason = serializers.CharField(max_length=300)


class OnSerializer(serializers.Serializer):
    on = serializers.DateField()


class ProductionOrderViewSet(DocumentViewSet):
    authz_resource = services.PO
    authz_actions = {
        "release": "release",
        "issue": "issue",
        "confirm": "confirm",
        "output": "receive",
        "scrap": "confirm",
        "close": "close",
        "cancel": "cancel",
        "availability": "read",
    }
    queryset = (
        ProductionOrder.objects.select_related("item")
        .prefetch_related("materials__item", "operations__work_center")
        .order_by("-created_at")
    )
    serializer_class = ProductionOrderSerializer
    filterset_fields = ["status", "facility", "item", "kind"]
    search_fields = ["number", "item__code"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_order(self.actor, **v), created=True)

    @extend_schema(request=None, responses=ProductionOrderSerializer)
    @action(detail=True, methods=["post"])
    def release(self, request, pk=None):
        return self.respond(services.release_order(self.actor, self.get_object()))

    @extend_schema(request=IssueSerializer, responses=ProductionOrderSerializer)
    @action(detail=True, methods=["post"])
    def issue(self, request, pk=None):
        v = self.validated(IssueSerializer)
        return self.respond(services.issue_materials(self.actor, self.get_object(), lines=v["lines"], on=v["on"]))

    @extend_schema(request=ConfirmSerializer, responses=ProductionOrderSerializer)
    @action(detail=True, methods=["post"])
    def confirm(self, request, pk=None):
        order = self.get_object()
        v = self.validated(ConfirmSerializer)
        if v["operation"].order_id != order.pk:
            raise serializers.ValidationError({"operation": ["Operation belongs to another order."]})
        services.confirm_operation(self.actor, v["operation"], minutes=v["minutes"], quantity=v["quantity"])
        return self.respond(order)

    @extend_schema(request=OutputSerializer, responses=ProductionOrderSerializer)
    @action(detail=True, methods=["post"])
    def output(self, request, pk=None):
        v = self.validated(OutputSerializer)
        return self.respond(services.receive_output(self.actor, self.get_object(), **v))

    @extend_schema(request=ScrapSerializer, responses=ProductionOrderSerializer)
    @action(detail=True, methods=["post"])
    def scrap(self, request, pk=None):
        v = self.validated(ScrapSerializer)
        return self.respond(services.record_scrap(self.actor, self.get_object(), **v))

    @extend_schema(request=OnSerializer, responses=ProductionOrderSerializer)
    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        v = self.validated(OnSerializer)
        return self.respond(services.close_order(self.actor, self.get_object(), on=v["on"]))

    @extend_schema(
        responses=inline_serializer("MaterialAvailability", {"shortage": serializers.DecimalField(20, 6)}, many=True)
    )
    @action(detail=True, methods=["get"], pagination_class=None)
    def availability(self, request, pk=None):
        order = self.get_object()
        return Response(
            services.availability_check(
                order.company_id, order.item, order.quantity, order.source_warehouse, order.planned_start
            )
        )

    @extend_schema(request=ReasonBody, responses=ProductionOrderSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        v = self.validated(ReasonBody)
        return self.respond(services.cancel_order(self.actor, self.get_object(), reason=v["reason"]))


router = SimpleRouter()
router.register("manufacturing/work-centers", WorkCenterViewSet, basename="work-center")
router.register("manufacturing/boms", BomViewSet, basename="bom")
router.register("manufacturing/orders", ProductionOrderViewSet, basename="production-order")
urlpatterns = router.urls
