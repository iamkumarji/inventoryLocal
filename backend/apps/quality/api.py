from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.routers import SimpleRouter

from apps.masterdata.models import Item
from apps.quality import services
from apps.quality.models import Inspection, InspectionPlan, NonConformance
from apps.shared.docviews import DocumentViewSet
from apps.shared.viewsets import MasterDataViewSet, master_schema


class PlanSerializer(serializers.ModelSerializer):
    item = serializers.PrimaryKeyRelatedField(queryset=Item.objects.all())

    def get_fields(self):
        fields = super().get_fields()
        request = self.context.get("request")
        if request is not None and getattr(request.user, "organization_id", None):
            fields["item"].queryset = Item.objects.filter(organization_id=request.user.organization_id)
        return fields

    class Meta:
        model = InspectionPlan
        fields = ["id", "version", "item", "stage", "parameters", "sample_size", "is_active"]
        read_only_fields = ["id", "version"]
        validators: list = []


class InspectionSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source="item.code", read_only=True)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True, default=None)

    class Meta:
        model = Inspection
        fields = [
            "id",
            "number",
            "stage",
            "item",
            "item_code",
            "warehouse",
            "batch",
            "serials",
            "quantity",
            "accepted_quantity",
            "rejected_quantity",
            "supplier",
            "supplier_name",
            "source_type",
            "source_id",
            "plan",
            "results",
            "remarks",
            "status",
            "inspected_by",
            "decided_at",
            "version",
            "created_at",
        ]
        read_only_fields = fields


class DecideSerializer(serializers.Serializer):
    accepted_quantity = serializers.DecimalField(max_digits=20, decimal_places=6)
    rejected_quantity = serializers.DecimalField(max_digits=20, decimal_places=6)
    results = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    remarks = serializers.CharField(required=False, allow_blank=True, default="")
    ncr_description = serializers.CharField(required=False, allow_blank=True, default="")
    version = serializers.IntegerField(required=False)


class NCRSerializer(serializers.ModelSerializer):
    class Meta:
        model = NonConformance
        fields = [
            "id",
            "number",
            "inspection",
            "description",
            "disposition",
            "corrective_action",
            "status",
            "closed_by",
            "version",
            "created_at",
        ]
        read_only_fields = fields


class CloseNCRSerializer(serializers.Serializer):
    disposition = serializers.ChoiceField(choices=NonConformance.Disposition.choices)
    corrective_action = serializers.CharField()


@master_schema
class PlanViewSet(MasterDataViewSet):
    authz_resource = "quality.inspection_plan"
    queryset = InspectionPlan.objects.all()
    serializer_class = PlanSerializer
    editable_fields = ("parameters", "sample_size", "is_active")
    filterset_fields = ["item", "stage", "is_active"]
    ordering = ["item__code"]


class InspectionViewSet(DocumentViewSet):
    authz_resource = "quality.inspection"
    authz_actions = {"decide": "approve"}
    queryset = Inspection.objects.select_related("item", "supplier").order_by("-created_at")
    serializer_class = InspectionSerializer
    filterset_fields = ["status", "stage", "warehouse", "item", "supplier"]
    search_fields = ["number"]

    @extend_schema(request=DecideSerializer, responses=InspectionSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = dict(self.validated(DecideSerializer))
        version = v.pop("version", None)
        return self.respond(services.decide(self.actor, self.get_object(), expected_version=version, **v))


class NCRViewSet(DocumentViewSet):
    authz_resource = "quality.ncr"
    authz_actions = {"close": "update"}
    queryset = NonConformance.objects.order_by("-created_at")
    serializer_class = NCRSerializer
    filterset_fields = ["status", "disposition"]

    @extend_schema(request=CloseNCRSerializer, responses=NCRSerializer)
    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        v = self.validated(CloseNCRSerializer)
        return self.respond(services.close_ncr(self.actor, self.get_object(), **v))


router = SimpleRouter()
router.register("quality/plans", PlanViewSet, basename="inspection-plan")
router.register("quality/inspections", InspectionViewSet, basename="inspection")
router.register("quality/ncrs", NCRViewSet, basename="ncr")
urlpatterns = router.urls
