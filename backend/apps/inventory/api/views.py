from django.db import transaction
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization import pdp
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet, ERPReadOnlyViewSet
from apps.core.exceptions import NotFound
from apps.core.idempotency import idempotency_header, idempotent
from apps.core.pagination import LedgerCursorPagination
from apps.inventory import documents, selectors
from apps.inventory.models import (
    Batch,
    ItemValuation,
    Location,
    SerialNumber,
    StockAdjustment,
    StockCount,
    StockLedgerEntry,
    StockTransfer,
)
from apps.masterdata.models import Item, ItemBarcode
from apps.organization.models import Warehouse
from apps.shared.docviews import ReasonBody
from apps.shared.viewsets import MasterDataViewSet, master_schema

from . import serializers as s

IDEM = idempotency_header(True)


@master_schema
class LocationViewSet(MasterDataViewSet):
    authz_resource = "inventory.location"
    queryset = Location.objects.all()
    serializer_class = s.LocationSerializer
    editable_fields = ("name", "kind", "parent", "is_active")
    filterset_fields = ["warehouse", "kind", "is_active"]

    def create_resource(self, validated):
        return pdp.Resource.ref(
            "inventory.location", company_id=validated["company"].pk, warehouse_id=validated["warehouse"].pk
        )


class StockViewSet(ERPReadOnlyViewSet):
    """On-hand quantity, reservations and value per item and warehouse."""

    authz_resource = "inventory.stock_balance"
    queryset = ItemValuation.objects.select_related("item__stock_uom", "warehouse").exclude(
        quantity=0, reserved_quantity=0
    )
    serializer_class = s.StockSerializer
    filterset_fields = ["item", "warehouse", "item__category", "item__item_type"]
    search_fields = ["item__code", "item__name"]
    ordering_fields = ["item__code", "value", "quantity"]
    ordering = ["item__code"]


class AvailabilityView(APIView):
    authz_resource = "inventory.stock_balance"
    authz_actions = {"get": "read"}

    @extend_schema(
        parameters=[OpenApiParameter("item", str, required=True), OpenApiParameter("warehouse", str, required=True)],
        responses=inline_serializer("Availability", {"available": serializers.DecimalField(20, 6)}),
    )
    def get(self, request):
        ctx = actor_for(request)
        warehouse = Warehouse.objects.filter(pk=request.query_params.get("warehouse")).first()
        if warehouse is None or not pdp.can(ctx, "inventory.stock_balance.read", pdp.Resource.of(warehouse)):
            raise NotFound()
        return Response(selectors.availability(warehouse.company_id, request.query_params.get("item"), warehouse.pk))


class LedgerViewSet(ERPReadOnlyViewSet):
    authz_resource = "inventory.stock_ledger"
    queryset = StockLedgerEntry.objects.select_related("item", "warehouse", "batch")
    serializer_class = s.LedgerSerializer
    pagination_class = LedgerCursorPagination
    filterset_fields = {
        "item": ["exact"],
        "warehouse": ["exact"],
        "movement_type": ["exact"],
        "source_type": ["exact"],
        "source_id": ["exact"],
        "posting_date": ["gte", "lte"],
    }
    ordering_fields: list[str] = []


class BatchViewSet(ERPReadOnlyViewSet):
    authz_resource = "inventory.batch"
    queryset = Batch.objects.select_related("item").order_by("expires_on", "batch_number")
    serializer_class = s.BatchSerializer
    filterset_fields = {"item": ["exact"], "expires_on": ["lte", "gte"]}
    search_fields = ["batch_number"]


class SerialViewSet(ERPReadOnlyViewSet):
    authz_resource = "inventory.batch"
    queryset = SerialNumber.objects.order_by("serial")
    serializer_class = s.SerialSerializer
    filterset_fields = ["item", "status", "warehouse"]
    search_fields = ["serial"]


class AgeingView(APIView):
    authz_resource = "inventory.stock_balance"
    authz_actions = {"get": "read"}

    @extend_schema(
        parameters=[OpenApiParameter("as_of", str)],
        responses=inline_serializer("Ageing", {"rows": serializers.ListField()}),
    )
    def get(self, request):
        ctx = actor_for(request)
        warehouses = pdp.filter_queryset(ctx, "inventory.stock_balance.read", Warehouse.objects.all())
        as_of = serializers.DateField().to_internal_value(
            request.query_params.get("as_of") or str(timezone.localdate())
        )
        return Response(
            {
                "as_of": as_of,
                "rows": selectors.ageing(ctx.company_id, list(warehouses.values_list("id", flat=True)), as_of),
            }
        )


class ScanView(APIView):
    """Resolve a scanned or typed code to an item (barcode or item code), batch, serial or bin."""

    authz_resource = "masterdata.item"
    authz_actions = {"get": "read"}

    @extend_schema(
        parameters=[OpenApiParameter("code", str, required=True)],
        responses=inline_serializer("ScanResult", {"kind": serializers.CharField()}),
    )
    def get(self, request):
        ctx = actor_for(request)
        code = request.query_params.get("code", "").strip()
        barcode = (
            ItemBarcode.objects.select_related("item")
            .filter(organization_id=request.user.organization_id, barcode=code)
            .first()
        )
        if barcode:
            return Response(
                {
                    "kind": "item",
                    "item_id": str(barcode.item_id),
                    "item_code": barcode.item.code,
                    "uom_id": str(barcode.uom_id) if barcode.uom_id else None,
                }
            )
        # Item codes too, so one call resolves anything a scanner or a person types (no 404-then-retry).
        item = Item.objects.filter(organization_id=request.user.organization_id, code=code).first()
        if item:
            return Response({"kind": "item", "item_id": str(item.pk), "item_code": item.code, "uom_id": None})
        serial = SerialNumber.objects.filter(company_id=ctx.company_id, serial=code).select_related("item").first()
        if serial:
            return Response(
                {
                    "kind": "serial",
                    "serial_id": str(serial.pk),
                    "item_id": str(serial.item_id),
                    "item_code": serial.item.code,
                    "status": serial.status,
                    "warehouse_id": str(serial.warehouse_id) if serial.warehouse_id else None,
                }
            )
        batch = Batch.objects.filter(company_id=ctx.company_id, batch_number=code).select_related("item").first()
        if batch:
            return Response(
                {
                    "kind": "batch",
                    "batch_id": str(batch.pk),
                    "item_id": str(batch.item_id),
                    "item_code": batch.item.code,
                    "expires_on": batch.expires_on,
                }
            )
        location = pdp.filter_queryset(ctx, "inventory.location.read", Location.objects.filter(code=code)).first()
        if location:
            return Response(
                {"kind": "location", "location_id": str(location.pk), "warehouse_id": str(location.warehouse_id)}
            )
        raise NotFound("Nothing matches that code.")


class _DocViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    def fresh(self, doc):
        return Response(self.get_serializer(self.get_queryset().get(pk=doc.pk)).data)


class AdjustmentViewSet(_DocViewSet):
    authz_resource = "inventory.stock_adjustment"
    authz_actions = {"submit": "update", "approve": "approve", "post_document": "post", "cancel": "update"}
    queryset = (
        StockAdjustment.objects.select_related("warehouse").prefetch_related("lines__item").order_by("-created_at")
    )
    serializer_class = s.AdjustmentSerializer
    filterset_fields = ["status", "warehouse", "reason"]
    search_fields = ["number", "notes"]

    def create(self, request):
        data = self.get_serializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = dict(data.validated_data)
        adj = documents.create_adjustment(
            self.actor,
            company=v["company"],
            warehouse=v["warehouse"],
            posting_date=v["posting_date"],
            reason=v["reason"],
            notes=v.get("notes", ""),
            lines=v["lines"],
        )
        return Response(self.get_serializer(self.get_queryset().get(pk=adj.pk)).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=s.DocVersionSerializer, responses=s.AdjustmentSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.fresh(documents.submit_adjustment(self.actor, self.get_object(), request.data.get("version")))

    @extend_schema(request=ReasonBody, responses=s.AdjustmentSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        data = ReasonBody(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        return self.fresh(
            documents.cancel_adjustment(
                self.actor, self.get_object(), reason=v["reason"], expected_version=v.get("version")
            )
        )

    @extend_schema(request=s.DocVersionSerializer, responses=s.AdjustmentSerializer)
    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        return self.fresh(
            documents.approve_adjustment_directly(self.actor, self.get_object(), request.data.get("version"))
        )

    @extend_schema(request=s.DocVersionSerializer, responses=s.AdjustmentSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        return self.fresh(documents.post_adjustment(self.actor, self.get_object(), request.data.get("version")))


class TransferViewSet(_DocViewSet):
    authz_resource = "inventory.stock_transfer"
    authz_actions = {"dispatch_transfer": "dispatch", "receive": "read"}  # receive is checked against the destination
    queryset = StockTransfer.objects.prefetch_related("lines__item").order_by("-created_at")
    serializer_class = s.TransferSerializer
    filterset_fields = ["status", "from_warehouse", "to_warehouse"]
    search_fields = ["number"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return StockTransfer.objects.none()
        ctx = self.actor
        q_from = pdp.scope_q(ctx, "inventory.stock_transfer.read", StockTransfer)
        visible_wh = pdp.filter_queryset(ctx, "inventory.stock_transfer.receive", Warehouse.objects.all())
        qs = StockTransfer.objects.filter(to_warehouse__in=visible_wh)
        if q_from is not None:
            qs = qs | StockTransfer.objects.filter(q_from)
        return qs.distinct().prefetch_related("lines__item").order_by("-created_at")

    def create(self, request):
        data = self.get_serializer(data=request.data)
        data.is_valid(raise_exception=True)
        v = dict(data.validated_data)
        transfer = documents.create_transfer(
            self.actor,
            company=v["company"],
            from_warehouse=v["from_warehouse"],
            to_warehouse=v["to_warehouse"],
            notes=v.get("notes", ""),
            lines=v["lines"],
        )
        return Response(
            self.get_serializer(self.get_queryset().get(pk=transfer.pk)).data, status=status.HTTP_201_CREATED
        )

    @extend_schema(request=s.DateSerializer, responses=s.TransferSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="dispatch")
    @idempotent(required=True)
    def dispatch_transfer(self, request, pk=None):  # never name a view method `dispatch` (DRF core)
        data = s.DateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(
            documents.dispatch_transfer(
                self.actor,
                self.get_object(),
                on=data.validated_data["on"],
                expected_version=data.validated_data.get("version"),
            )
        )

    @extend_schema(request=s.DateSerializer, responses=s.TransferSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def receive(self, request, pk=None):
        data = s.DateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return self.fresh(
            documents.receive_transfer(
                self.actor,
                self.get_object(),
                on=data.validated_data["on"],
                expected_version=data.validated_data.get("version"),
            )
        )

    def check_object_permissions(self, request, obj):
        if self.action == "receive":
            return  # the service checks `receive` at the destination warehouse
        super().check_object_permissions(request, obj)


class CountViewSet(_DocViewSet):
    authz_resource = "inventory.stock_count"
    authz_actions = {"record": "update", "post_document": "approve"}
    queryset = StockCount.objects.order_by("-count_date", "-created_at")
    serializer_class = s.CountSerializer
    filterset_fields = ["status", "warehouse"]

    def get_serializer_context(self):
        context = super().get_serializer_context()
        obj = getattr(self, "_count_obj", None)
        if obj is not None and obj.blind and obj.status != StockCount.Status.POSTED:
            context["hide_system"] = not pdp.can(self.actor, "inventory.stock_count.approve", pdp.Resource.of(obj))
        return context

    def get_object(self):
        self._count_obj = super().get_object()
        return self._count_obj

    @extend_schema(request=s.CountStartSerializer, responses={201: s.CountSerializer})
    def create(self, request):
        data = s.CountStartSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        count = documents.start_count(self.actor, **data.validated_data)
        self._count_obj = count
        return Response(self.get_serializer(count).data, status=status.HTTP_201_CREATED)

    def retrieve(self, request, *args, **kwargs):
        return Response(self.get_serializer(self.get_object()).data)

    @extend_schema(request=s.CountEntrySerializer(many=True), responses=s.CountSerializer)
    @action(detail=True, methods=["post"])
    @idempotent()
    def record(self, request, pk=None):
        data = s.CountEntrySerializer(data=request.data, many=True)
        data.is_valid(raise_exception=True)
        count = documents.record_counts(self.actor, self.get_object(), data.validated_data)
        return Response(self.get_serializer(count).data)

    @extend_schema(request=s.DocVersionSerializer, responses=s.CountSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        with transaction.atomic():
            count = documents.post_count(self.actor, self.get_object(), request.data.get("version"))
        return Response(self.get_serializer(count).data)
