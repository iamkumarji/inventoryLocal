"""REST API for fixed assets and maintenance. Thin views: validate -> service -> serialize."""

from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter

from apps.assets import services
from apps.assets.models import (
    Asset,
    AssetCategory,
    DepreciationEntry,
    DepreciationRun,
    MaintenancePlan,
    MaintenanceWorkOrder,
    MeterReading,
    WorkOrderSpare,
)
from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.core.idempotency import idempotency_header, idempotent
from apps.finance.models import Account
from apps.identity.models import User
from apps.masterdata.models import Item
from apps.organization.models import Company, Facility, Warehouse
from apps.partners.models import Partner
from apps.shared.docviews import DecisionBody, DocumentViewSet, VersionBody
from apps.shared.viewsets import MasterDataViewSet, master_schema

IDEM = idempotency_header(True)


def _account_field(read_action: str):
    """Postable GL account limited to companies the caller can read in this context."""
    return ScopedPrimaryKeyRelatedField(
        queryset=Account.objects.filter(is_group=False, is_active=True),
        read_action=read_action,
        required=False,
        allow_null=True,
    )


def _users():
    return User.objects.filter(is_active=True)


def _version(request) -> int | None:
    value = request.data.get("version")
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise serializers.ValidationError({"version": ["Must be an integer."]}) from None


# --- Categories -----------------------------------------------------------------------------------


class AssetCategorySerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="assets.asset_category.read")
    fixed_asset_account = _account_field("assets.asset_category.read")
    accumulated_depreciation_account = _account_field("assets.asset_category.read")
    depreciation_expense_account = _account_field("assets.asset_category.read")

    class Meta:
        model = AssetCategory
        fields = [
            "id",
            "version",
            "company",
            "code",
            "name",
            "depreciation_method",
            "useful_life_months",
            "wdv_rate",
            "salvage_pct",
            "fixed_asset_account",
            "accumulated_depreciation_account",
            "depreciation_expense_account",
            "is_active",
        ]
        read_only_fields = ["id", "version"]
        validators: list = []

    def validate(self, attrs):
        merged = {
            **(
                {f: getattr(self.instance, f) for f in self.Meta.fields if hasattr(self.instance, f)}
                if self.instance
                else {}
            ),
            **attrs,
        }
        company = merged.get("company")
        services.validate_category(merged, company.pk if company else None)
        return attrs


@master_schema
class AssetCategoryViewSet(MasterDataViewSet):
    authz_resource = "assets.asset_category"
    queryset = AssetCategory.objects.all()
    serializer_class = AssetCategorySerializer
    editable_fields = (
        "name",
        "depreciation_method",
        "useful_life_months",
        "wdv_rate",
        "salvage_pct",
        "fixed_asset_account",
        "accumulated_depreciation_account",
        "depreciation_expense_account",
        "is_active",
    )
    filterset_fields = ["depreciation_method", "is_active"]
    search_fields = ["code", "name"]


# --- Assets ---------------------------------------------------------------------------------------


class AssetSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="assets.asset.read")
    facility = ScopedPrimaryKeyRelatedField(queryset=Facility.objects.all(), read_action="assets.asset.read")
    category = ScopedPrimaryKeyRelatedField(
        queryset=AssetCategory.objects.filter(is_active=True), read_action="assets.asset.read"
    )
    custodian = serializers.PrimaryKeyRelatedField(queryset=_users(), required=False, allow_null=True)
    contra_account = _account_field("assets.asset.read")
    contra_partner = serializers.PrimaryKeyRelatedField(queryset=Partner.objects.all(), required=False, allow_null=True)
    category_code = serializers.CharField(source="category.code", read_only=True)
    salvage_value = serializers.DecimalField(max_digits=20, decimal_places=4, required=False, allow_null=True)
    depreciation_method = serializers.ChoiceField(
        choices=Asset._meta.get_field("depreciation_method").choices, required=False
    )
    useful_life_months = serializers.IntegerField(min_value=0, required=False, allow_null=True)
    wdv_rate = serializers.DecimalField(max_digits=9, decimal_places=4, required=False, allow_null=True)

    class Meta:
        model = Asset
        fields = [
            "id",
            "version",
            "company",
            "facility",
            "category",
            "category_code",
            "code",
            "name",
            "serial_number",
            "custodian",
            "location",
            "acquisition_date",
            "put_to_use_date",
            "capitalization_date",
            "cost",
            "salvage_value",
            "depreciation_method",
            "useful_life_months",
            "wdv_rate",
            "contra_account",
            "contra_partner",
            "status",
            "accumulated_depreciation",
            "book_value",
            "capitalization_journal",
            "capitalized_at",
            "submitted_by",
            "approved_by",
            "disposal_kind",
            "disposal_date",
            "disposal_proceeds",
            "disposal_gain",
            "disposal_journal",
            "current_meter_reading",
            "created_by",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "version",
            "status",
            "accumulated_depreciation",
            "book_value",
            "capitalization_journal",
            "capitalized_at",
            "submitted_by",
            "approved_by",
            "disposal_kind",
            "disposal_date",
            "disposal_proceeds",
            "disposal_gain",
            "disposal_journal",
            "current_meter_reading",
            "created_by",
            "created_at",
        ]
        validators: list = []


class AssetUpdateSerializer(AssetSerializer):
    version = serializers.IntegerField()

    class Meta(AssetSerializer.Meta):
        read_only_fields = [f for f in AssetSerializer.Meta.read_only_fields if f != "version"] + ["code"]


class AssetDisposalSerializer(serializers.Serializer):
    on = serializers.DateField()
    disposal_kind = serializers.ChoiceField(choices=Asset.DisposalKind.choices)
    proceeds = serializers.DecimalField(max_digits=20, decimal_places=4, min_value=0, required=False, default=0)
    proceeds_account = _account_field("assets.asset.dispose")
    gain_account = _account_field("assets.asset.dispose")
    loss_account = _account_field("assets.asset.dispose")
    reason = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    version = serializers.IntegerField(required=False)


class AssetReliabilitySerializer(serializers.Serializer):
    asset = serializers.UUIDField()
    asset_code = serializers.CharField()
    window_start = serializers.DateTimeField()
    window_end = serializers.DateTimeField()
    failures = serializers.IntegerField()
    downtime_hours = serializers.DecimalField(max_digits=20, decimal_places=2)
    operating_hours = serializers.DecimalField(max_digits=20, decimal_places=2)
    mtbf_hours = serializers.DecimalField(max_digits=20, decimal_places=2, allow_null=True)
    mttr_hours = serializers.DecimalField(max_digits=20, decimal_places=2, allow_null=True)
    availability_pct = serializers.DecimalField(max_digits=9, decimal_places=2, allow_null=True)


WINDOW_PARAMS = [
    OpenApiParameter("start", str, description="ISO datetime; defaults to the put-to-use date"),
    OpenApiParameter("end", str, description="ISO datetime; defaults to now"),
]


class AssetViewSet(DocumentViewSet):
    authz_resource = services.ASSET
    authz_actions = {
        "submit": "update",
        "decide": "approve",
        "capitalize": "approve",
        "dispose": "dispose",
        "reliability": "read",
    }
    queryset = Asset.objects.select_related("category").order_by("code")
    serializer_class = AssetSerializer
    filterset_fields = ["status", "facility", "category", "custodian"]
    search_fields = ["code", "name", "serial_number"]

    @extend_schema(request=AssetSerializer, responses={201: AssetSerializer})
    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_asset(self.actor, **v), created=True)

    @extend_schema(
        request=AssetUpdateSerializer,
        responses=AssetSerializer,
        description="Partial update; send `version` for optimistic locking.",
    )
    def partial_update(self, request, pk=None):
        asset = self.get_object()
        data = AssetUpdateSerializer(asset, data=request.data, partial=True, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        changes = {k: v for k, v in data.validated_data.items() if k != "version"}
        return self.respond(services.update_asset(self.actor, asset, changes, _version(request)))

    @extend_schema(
        request=VersionBody,
        responses=AssetSerializer,
        parameters=[IDEM],
        description="Capitalize directly (approver within limit). Posts Dr fixed assets / Cr contra.",
    )
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def capitalize(self, request, pk=None):
        return self.respond(services.capitalize(self.actor, self.get_object(), self.version()))

    @extend_schema(
        request=VersionBody,
        responses=AssetSerializer,
        description="Route capitalization through the approvals workflow (above the approver's limit).",
    )
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.respond(services.submit_for_capitalization(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DecisionBody, responses=AssetSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            services.decide_capitalization(
                self.actor,
                self.get_object(),
                approve=v["approve"],
                comment=v["comment"],
                expected_version=v.get("version"),
            )
        )

    @extend_schema(request=AssetDisposalSerializer, responses=AssetSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def dispose(self, request, pk=None):
        v = dict(self.validated(AssetDisposalSerializer))
        return self.respond(
            services.dispose(
                self.actor, self.get_object(), kind=v.pop("disposal_kind"), expected_version=v.pop("version", None), **v
            )
        )

    @extend_schema(parameters=WINDOW_PARAMS, responses=AssetReliabilitySerializer)
    @action(detail=True, methods=["get"])
    def reliability(self, request, pk=None):
        field = serializers.DateTimeField()
        window = {
            k: field.to_internal_value(request.query_params[k]) for k in ("start", "end") if request.query_params.get(k)
        }
        return Response(AssetReliabilitySerializer(services.reliability(self.get_object(), **window)).data)


# --- Meter readings -------------------------------------------------------------------------------


class AssetMeterReadingSerializer(serializers.ModelSerializer):
    asset = ScopedPrimaryKeyRelatedField(queryset=Asset.objects.all(), read_action="assets.meter_reading.read")
    reading_at = serializers.DateTimeField(required=False)

    class Meta:
        model = MeterReading
        fields = ["id", "asset", "reading", "reading_at", "notes", "recorded_by", "created_at"]
        read_only_fields = ["id", "recorded_by", "created_at"]


class MeterReadingViewSet(DocumentViewSet):
    authz_resource = services.METER
    queryset = MeterReading.objects.order_by("-reading_at")
    serializer_class = AssetMeterReadingSerializer
    filterset_fields = ["asset"]

    @extend_schema(request=AssetMeterReadingSerializer, responses={201: AssetMeterReadingSerializer})
    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.record_meter_reading(self.actor, v.pop("asset"), **v), created=True)


# --- Depreciation ---------------------------------------------------------------------------------


class DepreciationEntrySerializer(serializers.ModelSerializer):
    asset_code = serializers.CharField(source="asset.code", read_only=True)

    class Meta:
        model = DepreciationEntry
        fields = ["id", "asset", "asset_code", "period", "opening_book_value", "amount", "book_value_after", "days"]
        read_only_fields = fields


class DepreciationRunSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="assets.depreciation_run.read")
    entries = DepreciationEntrySerializer(many=True, read_only=True)

    class Meta:
        model = DepreciationRun
        fields = [
            "id",
            "version",
            "company",
            "period",
            "status",
            "total_amount",
            "asset_count",
            "journal_entry",
            "posted_by",
            "posted_at",
            "reversal_journal",
            "reversed_by",
            "reversed_at",
            "reversal_reason",
            "entries",
            "created_by",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "version",
            "status",
            "total_amount",
            "asset_count",
            "journal_entry",
            "posted_by",
            "posted_at",
            "reversal_journal",
            "reversed_by",
            "reversed_at",
            "reversal_reason",
            "created_by",
            "created_at",
        ]
        validators: list = []  # one run per month is a business rule enforced (422) by the service


class DepreciationPreviewLineSerializer(serializers.Serializer):
    asset = serializers.UUIDField()
    asset_code = serializers.CharField()
    method = serializers.CharField()
    opening_book_value = serializers.DecimalField(max_digits=20, decimal_places=4)
    amount = serializers.DecimalField(max_digits=20, decimal_places=4)
    book_value_after = serializers.DecimalField(max_digits=20, decimal_places=4)
    days = serializers.IntegerField()


class DepreciationReversalSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=300)
    reversal_date = serializers.DateField(required=False, allow_null=True)
    version = serializers.IntegerField(required=False)


class DepreciationRunViewSet(DocumentViewSet):
    authz_resource = services.RUN
    authz_actions = {"preview": "read", "post_run": "post", "reverse": "cancel"}
    queryset = DepreciationRun.objects.prefetch_related("entries__asset").order_by("-period", "-created_at")
    serializer_class = DepreciationRunSerializer
    filterset_fields = ["status", "period"]

    @extend_schema(request=DepreciationRunSerializer, responses={201: DepreciationRunSerializer})
    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_run(self.actor, **v), created=True)

    @extend_schema(responses=DepreciationPreviewLineSerializer(many=True))
    @action(detail=True, methods=["get"], pagination_class=None)
    def preview(self, request, pk=None):
        lines = [ln.as_dict() for ln in services.compute_run(self.get_object())]
        return Response(DepreciationPreviewLineSerializer(lines, many=True).data)

    @extend_schema(request=VersionBody, responses=DepreciationRunSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_run(self, request, pk=None):
        return self.respond(services.post_run(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DepreciationReversalSerializer, responses=DepreciationRunSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def reverse(self, request, pk=None):
        v = self.validated(DepreciationReversalSerializer)
        return self.respond(
            services.reverse_run(
                self.actor,
                self.get_object(),
                reason=v["reason"],
                reversal_date=v.get("reversal_date"),
                expected_version=v.get("version"),
            )
        )


# --- Maintenance plans ----------------------------------------------------------------------------


class MaintenancePlanSerializer(serializers.ModelSerializer):
    asset = ScopedPrimaryKeyRelatedField(queryset=Asset.objects.all(), read_action="assets.maintenance_plan.read")
    asset_code = serializers.CharField(source="asset.code", read_only=True)
    technician = serializers.PrimaryKeyRelatedField(queryset=_users(), required=False, allow_null=True)
    checklist = serializers.ListField(child=serializers.JSONField(), required=False)

    class Meta:
        model = MaintenancePlan
        fields = [
            "id",
            "version",
            "asset",
            "asset_code",
            "facility",
            "name",
            "trigger",
            "interval_days",
            "interval_meter",
            "checklist",
            "next_due_date",
            "next_due_meter",
            "technician",
            "last_generated_at",
            "is_active",
            "created_at",
        ]
        read_only_fields = ["id", "version", "facility", "last_generated_at", "created_at"]


class MaintenancePlanUpdateSerializer(MaintenancePlanSerializer):
    version = serializers.IntegerField()

    class Meta(MaintenancePlanSerializer.Meta):
        read_only_fields = ["id", "asset", "trigger", "facility", "last_generated_at", "created_at"]


class GenerateWorkOrdersSerializer(serializers.Serializer):
    on = serializers.DateField()


class MaintenancePlanViewSet(DocumentViewSet):
    authz_resource = services.PLAN
    authz_actions = {"generate": f"{services.WO}.create"}
    queryset = MaintenancePlan.objects.select_related("asset").order_by("next_due_date", "name")
    serializer_class = MaintenancePlanSerializer
    filterset_fields = ["asset", "trigger", "is_active", "facility"]
    search_fields = ["name", "asset__code"]

    @extend_schema(request=MaintenancePlanSerializer, responses={201: MaintenancePlanSerializer})
    def create(self, request):
        v = dict(self.validated())
        if v.get("is_active") is False:
            raise serializers.ValidationError({"is_active": ["Create the plan active; deactivate it later."]})
        v.pop("is_active", None)
        return self.respond(services.create_plan(self.actor, **v), created=True)

    @extend_schema(
        request=MaintenancePlanUpdateSerializer,
        responses=MaintenancePlanSerializer,
        description="Partial update; send `version` for optimistic locking.",
    )
    def partial_update(self, request, pk=None):
        plan = self.get_object()
        data = MaintenancePlanUpdateSerializer(
            plan, data=request.data, partial=True, context=self.get_serializer_context()
        )
        data.is_valid(raise_exception=True)
        changes = {k: v for k, v in data.validated_data.items() if k != "version"}
        return self.respond(services.update_plan(self.actor, plan, changes, _version(request)))

    @extend_schema(
        request=GenerateWorkOrdersSerializer,
        responses=inline_serializer(
            "GeneratedWorkOrders",
            {
                "created": serializers.IntegerField(),
                "work_orders": serializers.ListField(child=serializers.UUIDField()),
            },
        ),
    )
    @action(detail=False, methods=["post"])
    def generate(self, request):
        v = self.validated(GenerateWorkOrdersSerializer)
        created = services.generate_due_work_orders(self.actor, v["on"], company_id=self.actor.company_id)
        return Response({"created": len(created), "work_orders": [str(wo.pk) for wo in created]})


# --- Work orders ----------------------------------------------------------------------------------


class WorkOrderSpareSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = WorkOrderSpare
        fields = [
            "id",
            "item",
            "item_code",
            "warehouse",
            "quantity",
            "value",
            "stock_transaction",
            "issued_on",
            "issued_by",
        ]
        read_only_fields = fields


class WorkOrderSerializer(serializers.ModelSerializer):
    asset = ScopedPrimaryKeyRelatedField(queryset=Asset.objects.all(), read_action="assets.work_order.read")
    asset_code = serializers.CharField(source="asset.code", read_only=True)
    technician = serializers.PrimaryKeyRelatedField(queryset=_users(), required=False, allow_null=True)
    reported_at = serializers.DateTimeField(required=False)
    spares = WorkOrderSpareSerializer(many=True, read_only=True)

    class Meta:
        model = MaintenanceWorkOrder
        fields = [
            "id",
            "version",
            "number",
            "kind",
            "status",
            "asset",
            "asset_code",
            "facility",
            "plan",
            "due_key",
            "description",
            "checklist",
            "reported_at",
            "started_at",
            "completed_at",
            "closed_at",
            "downtime_minutes",
            "technician",
            "labour_hours",
            "spare_cost",
            "notes",
            "spares",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "version",
            "number",
            "status",
            "facility",
            "plan",
            "due_key",
            "checklist",
            "started_at",
            "completed_at",
            "closed_at",
            "downtime_minutes",
            "labour_hours",
            "spare_cost",
            "notes",
            "created_at",
        ]


class WorkOrderStartSerializer(serializers.Serializer):
    started_at = serializers.DateTimeField(required=False, allow_null=True)
    technician = serializers.PrimaryKeyRelatedField(queryset=_users(), required=False, allow_null=True)
    version = serializers.IntegerField(required=False)


class SpareLineSerializer(serializers.Serializer):
    item = serializers.PrimaryKeyRelatedField(queryset=Item.objects.filter(is_active=True))
    warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.all())
    quantity = serializers.DecimalField(max_digits=20, decimal_places=6, min_value=0)
    batch_number = serializers.CharField(required=False, allow_blank=True, default="")
    serials = serializers.ListField(child=serializers.CharField(), required=False, default=list)


class IssueSparesSerializer(serializers.Serializer):
    on = serializers.DateField()
    lines = SpareLineSerializer(many=True)
    version = serializers.IntegerField(required=False)


class WorkOrderCompleteSerializer(serializers.Serializer):
    completed_at = serializers.DateTimeField(required=False, allow_null=True)
    downtime_minutes = serializers.IntegerField(min_value=0, required=False, allow_null=True)
    labour_hours = serializers.DecimalField(
        max_digits=10, decimal_places=2, min_value=0, required=False, allow_null=True
    )
    notes = serializers.CharField(required=False, allow_blank=True, default="")
    checklist = serializers.ListField(child=serializers.JSONField(), required=False, allow_null=True)
    version = serializers.IntegerField(required=False)


class WorkOrderCancelSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=300)
    version = serializers.IntegerField(required=False)


class WorkOrderViewSet(DocumentViewSet):
    authz_resource = services.WO
    authz_actions = {
        "start": "update",
        "issue_spares": "update",
        "complete": "update",
        "close": "close",
        "cancel": "close",
    }
    queryset = (
        MaintenanceWorkOrder.objects.select_related("asset").prefetch_related("spares__item").order_by("-reported_at")
    )
    serializer_class = WorkOrderSerializer
    filterset_fields = ["status", "kind", "asset", "facility", "technician", "plan"]
    search_fields = ["number", "asset__code", "description"]

    @extend_schema(request=WorkOrderSerializer, responses={201: WorkOrderSerializer})
    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_work_order(self.actor, **v), created=True)

    @extend_schema(request=WorkOrderStartSerializer, responses=WorkOrderSerializer)
    @action(detail=True, methods=["post"])
    def start(self, request, pk=None):
        v = dict(self.validated(WorkOrderStartSerializer))
        return self.respond(
            services.start_work_order(self.actor, self.get_object(), expected_version=v.pop("version", None), **v)
        )

    @extend_schema(request=IssueSparesSerializer, responses=WorkOrderSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="issue-spares")
    @idempotent(required=True)
    def issue_spares(self, request, pk=None):
        v = self.validated(IssueSparesSerializer)
        return self.respond(
            services.issue_spares(
                self.actor, self.get_object(), lines=v["lines"], on=v["on"], expected_version=v.get("version")
            )
        )

    @extend_schema(request=WorkOrderCompleteSerializer, responses=WorkOrderSerializer)
    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        v = dict(self.validated(WorkOrderCompleteSerializer))
        return self.respond(
            services.complete_work_order(self.actor, self.get_object(), expected_version=v.pop("version", None), **v)
        )

    @extend_schema(request=VersionBody, responses=WorkOrderSerializer)
    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        return self.respond(services.close_work_order(self.actor, self.get_object(), self.version()))

    @extend_schema(request=WorkOrderCancelSerializer, responses=WorkOrderSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        v = self.validated(WorkOrderCancelSerializer)
        return self.respond(
            services.cancel_work_order(
                self.actor, self.get_object(), reason=v["reason"], expected_version=v.get("version")
            )
        )


router = SimpleRouter()
router.register("assets/categories", AssetCategoryViewSet, basename="asset-category")
router.register("assets/assets", AssetViewSet, basename="asset")
router.register("assets/meter-readings", MeterReadingViewSet, basename="asset-meter-reading")
router.register("assets/depreciation-runs", DepreciationRunViewSet, basename="depreciation-run")
router.register("assets/maintenance-plans", MaintenancePlanViewSet, basename="maintenance-plan")
router.register("assets/work-orders", WorkOrderViewSet, basename="maintenance-work-order")
urlpatterns = router.urls
