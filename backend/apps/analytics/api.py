from datetime import date
from decimal import Decimal

from django.http import HttpResponse
from django.urls import path
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema, inline_serializer
from rest_framework import mixins, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter
from rest_framework.views import APIView

from apps.authorization import pdp
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet
from apps.core.exceptions import NotFound
from apps.inventory.models import StockLedgerEntry
from apps.masterdata.models import Item

from . import dashboards, forecasting, services
from .models import ReportJob
from .reports import REPORTS, may_export

FREE_FORM = inline_serializer("AnalyticsResult", {"detail": serializers.JSONField(required=False)})


def _company(request):
    ctx = actor_for(request)
    if ctx.company_id is None:
        raise NotFound("Choose a company first.")
    return ctx, ctx.company_id


class DashboardQuery(serializers.Serializer):
    date_from = serializers.DateField(required=False)
    date_to = serializers.DateField(required=False)

    def validate(self, attrs):
        today = date.today()
        attrs.setdefault("date_to", today)
        attrs.setdefault("date_from", attrs["date_to"].replace(day=1))
        if attrs["date_from"] > attrs["date_to"]:
            raise serializers.ValidationError({"date_from": "Must not be after date_to."})
        if (attrs["date_to"] - attrs["date_from"]).days > 731:
            raise serializers.ValidationError({"date_from": "Choose a range of at most two years."})
        return attrs


class DashboardListView(APIView):
    authz_resource = "analytics.dashboard"
    authz_actions = {"get": "read"}

    @extend_schema(
        operation_id="analytics_dashboards_list",
        responses=inline_serializer(
            "DashboardIndex",
            {"dashboards": serializers.ListField(child=serializers.CharField())},
        ),
    )
    def get(self, request):
        return Response({"dashboards": list(dashboards.DASHBOARDS)})


class DashboardView(APIView):
    authz_resource = "analytics.dashboard"
    authz_actions = {"get": "read"}

    @extend_schema(
        parameters=[OpenApiParameter("date_from", date), OpenApiParameter("date_to", date)],
        responses=FREE_FORM,
    )
    def get(self, request, name):
        if name not in dashboards.DASHBOARDS:
            raise NotFound()
        # The endpoint check (any analytics.dashboard.read grant) is enough here: every widget applies
        # its own domain permission and scope, so a storekeeper's dashboard covers their warehouses.
        ctx, company_id = _company(request)
        query = DashboardQuery(data=request.query_params)
        query.is_valid(raise_exception=True)
        return Response(dashboards.build(ctx, name, company_id, **query.validated_data))


class ForecastQuery(serializers.Serializer):
    item = serializers.UUIDField()
    method = serializers.ChoiceField(choices=["moving_average", "exponential_smoothing"], default="moving_average")
    history_months = serializers.IntegerField(min_value=3, max_value=36, default=12)
    horizon_months = serializers.IntegerField(min_value=1, max_value=12, default=3)
    window = serializers.IntegerField(min_value=1, max_value=12, default=3)
    alpha = serializers.DecimalField(
        max_digits=3, decimal_places=2, min_value=Decimal("0.05"), max_value=Decimal("0.95"), default=Decimal("0.3")
    )


class ForecastView(APIView):
    authz_resource = "analytics.forecast"
    authz_actions = {"get": "read"}

    @extend_schema(parameters=[ForecastQuery], responses=FREE_FORM)
    def get(self, request):
        ctx, company_id = _company(request)
        query = ForecastQuery(data=request.query_params)
        query.is_valid(raise_exception=True)
        params = dict(query.validated_data)
        item = Item.objects.filter(pk=params.pop("item"), organization_id=request.user.organization_id).first()
        if item is None:
            raise NotFound()
        # Demand history comes only from warehouses whose stock ledger the user may read.
        warehouse_ids = set(
            pdp.filter_queryset(
                ctx, "inventory.stock_ledger.read", StockLedgerEntry.objects.filter(company_id=company_id, item=item)
            ).values_list("warehouse_id", flat=True)
        )
        if not warehouse_ids and not pdp.has_any_grant(ctx, "inventory.stock_ledger.read").allowed:
            raise NotFound()
        result = forecasting.forecast(company_id, item.pk, as_of=date.today(), warehouse_ids=warehouse_ids, **params)
        return Response({"item": {"id": str(item.pk), "code": item.code, "name": item.name}, **result})


class ReportTypesView(APIView):
    authz_resource = "analytics.report"
    authz_actions = {"get": "read"}

    @extend_schema(responses=FREE_FORM)
    def get(self, request):
        ctx, company_id = _company(request)
        return Response(
            {
                "report_types": [
                    {"code": r.code, "label": r.label, "params": list(r.params)}
                    for r in REPORTS.values()
                    if may_export(ctx, r, company_id)
                ]
            }
        )


class ReportJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReportJob
        fields = [
            "id",
            "report_type",
            "params",
            "status",
            "row_count",
            "error",
            "created_at",
            "started_at",
            "finished_at",
            "expires_at",
        ]
        read_only_fields = fields


class ReportJobCreateSerializer(serializers.Serializer):
    report_type = serializers.ChoiceField(choices=sorted(REPORTS))
    params = serializers.DictField(child=serializers.CharField(), default=dict)


class ReportJobViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "analytics.report"
    authz_actions = {"download": "read"}
    queryset = ReportJob.objects.order_by("-created_at")
    serializer_class = ReportJobSerializer
    filterset_fields = ["status", "report_type"]

    def get_queryset(self):
        # Exports are personal: even an administrator only sees their own.
        ctx = actor_for(self.request)
        return super().get_queryset().filter(created_by=self.request.user, company_id=ctx.company_id)

    @extend_schema(request=ReportJobCreateSerializer, responses={202: ReportJobSerializer})
    def create(self, request):
        ctx, company_id = _company(request)
        data = ReportJobCreateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        job = services.request_report(ctx, company_id=company_id, **data.validated_data)
        return Response(ReportJobSerializer(job).data, status=202)

    @extend_schema(responses={(200, "text/csv"): OpenApiResponse(response=str)})
    @action(detail=True, methods=["get"])
    def download(self, request, pk=None):
        job = self.get_object()
        body = services.download(actor_for(request), job)
        response = HttpResponse(body, content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{job.report_type}-{job.created_at:%Y%m%d}.csv"'
        response["Cache-Control"] = "no-store"
        return response


router = SimpleRouter()
router.register("analytics/reports", ReportJobViewSet, basename="report-job")
urlpatterns = [
    path("analytics/dashboards/", DashboardListView.as_view(), name="analytics-dashboards"),
    path("analytics/dashboards/<str:name>/", DashboardView.as_view(), name="analytics-dashboard"),
    path("analytics/forecast/", ForecastView.as_view(), name="analytics-forecast"),
    path("analytics/report-types/", ReportTypesView.as_view(), name="analytics-report-types"),
    *router.urls,
]
