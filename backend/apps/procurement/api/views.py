from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.authorization import pdp
from apps.core.idempotency import idempotency_header, idempotent
from apps.procurement import services
from apps.procurement.models import (
    GoodsReceipt,
    PurchaseOrder,
    PurchaseRequisition,
    PurchaseReturn,
    RequestForQuotation,
)
from apps.shared import workflow
from apps.shared.docviews import DecisionBody, DocumentViewSet, ReasonBody, VersionBody

from . import serializers as s

IDEM = idempotency_header(True)


class RequisitionViewSet(DocumentViewSet):
    authz_resource = services.PR
    authz_actions = {"submit": "update", "decide": "approve", "cancel": "cancel"}
    queryset = PurchaseRequisition.objects.prefetch_related("lines__item").order_by("-created_at")
    serializer_class = s.PurchaseRequisitionSerializer
    filterset_fields = ["status", "branch", "department"]
    search_fields = ["number", "purpose"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_requisition(self.actor, **v), created=True)

    @extend_schema(request=VersionBody, responses=s.PurchaseRequisitionSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.respond(services.submit_requisition(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DecisionBody, responses=s.PurchaseRequisitionSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            workflow.decide_directly(
                self.actor,
                self.get_object(),
                document_type=services.PR,
                approve=v["approve"],
                comment=v["comment"],
                expected_version=v.get("version"),
            )
        )

    @extend_schema(request=ReasonBody, responses=s.PurchaseRequisitionSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        v = self.validated(ReasonBody)
        return self.respond(services.cancel_requisition(self.actor, self.get_object(), v["reason"]))


class RFQViewSet(DocumentViewSet):
    authz_resource = "procurement.rfq"
    authz_actions = {"quotations": "update", "comparison": "read", "select": "approve"}
    queryset = RequestForQuotation.objects.prefetch_related("lines", "suppliers").order_by("-created_at")
    serializer_class = s.PurchaseRFQSerializer
    filterset_fields = ["status", "branch"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_rfq(self.actor, **v), created=True)

    @extend_schema(request=s.PurchaseQuotationSerializer, responses={201: s.PurchaseQuotationSerializer})
    @action(detail=True, methods=["post"])
    def quotations(self, request, pk=None):
        v = dict(self.validated(s.PurchaseQuotationSerializer))
        quote = services.record_quotation(self.actor, self.get_object(), **v)
        return Response(s.PurchaseQuotationSerializer(quote).data, status=201)

    @extend_schema(
        responses=inline_serializer("QuotationRanking", {"score": serializers.DecimalField(10, 2)}, many=True)
    )
    @action(detail=True, methods=["get"], pagination_class=None)
    def comparison(self, request, pk=None):
        return Response(services.compare_quotations(self.get_object()))

    @extend_schema(request=s.PurchaseSelectQuotationSerializer, responses=s.PurchaseOrderSerializer)
    @action(detail=True, methods=["post"])
    def select(self, request, pk=None):
        self.get_object()
        v = self.validated(s.PurchaseSelectQuotationSerializer)
        po = services.select_quotation(
            self.actor, v["quotation"], reason=v["reason"], warehouse=v["warehouse"], expected_date=v["expected_date"]
        )
        return Response(s.PurchaseOrderSerializer(PurchaseOrder.objects.get(pk=po.pk)).data)


class OrderViewSet(DocumentViewSet):
    authz_resource = services.PO
    authz_actions = {"submit": "update", "decide": "approve", "cancel": "cancel"}
    queryset = PurchaseOrder.objects.select_related("supplier").prefetch_related("lines__item").order_by("-created_at")
    serializer_class = s.PurchaseOrderSerializer
    filterset_fields = ["status", "receipt_status", "supplier", "branch"]
    search_fields = ["number", "supplier__name"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_order(self.actor, **v), created=True)

    @extend_schema(request=VersionBody, responses=s.PurchaseOrderSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.respond(services.submit_order(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DecisionBody, responses=s.PurchaseOrderSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            workflow.decide_directly(
                self.actor,
                self.get_object(),
                document_type=services.PO,
                approve=v["approve"],
                comment=v["comment"],
                expected_version=v.get("version"),
            )
        )

    @extend_schema(request=DecisionBody, responses=s.PurchaseOrderSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        return self.respond(services.cancel_order(self.actor, self.get_object(), request.data.get("comment", "")))


class ReceiptViewSet(DocumentViewSet):
    authz_resource = services.GRN
    authz_actions = {"post_document": "post"}
    queryset = (
        GoodsReceipt.objects.select_related("supplier").prefetch_related("lines__po_line__item").order_by("-created_at")
    )
    serializer_class = s.PurchaseReceiptSerializer
    filterset_fields = ["status", "warehouse", "purchase_order", "supplier"]
    search_fields = ["number", "supplier_delivery_note"]

    @idempotent()
    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_receipt(self.actor, order=v.pop("purchase_order"), **v), created=True)

    @extend_schema(request=VersionBody, responses=s.PurchaseReceiptSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        return self.respond(services.post_receipt(self.actor, self.get_object(), self.version()))


class ReturnViewSet(DocumentViewSet):
    authz_resource = "procurement.purchase_return"
    authz_actions = {"post_document": "post"}
    queryset = PurchaseReturn.objects.prefetch_related("lines").order_by("-created_at")
    serializer_class = s.PurchaseReturnSerializer
    filterset_fields = ["status", "supplier"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_return(self.actor, **v), created=True)

    @extend_schema(request=VersionBody, responses=s.PurchaseReturnSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        return self.respond(services.post_return(self.actor, self.get_object(), self.version()))


class MrpRunRequestSerializer(serializers.Serializer):
    horizon_days = serializers.IntegerField(default=30, min_value=1, max_value=365)


class MrpViewSet(DocumentViewSet):
    authz_resource = "procurement.mrp"
    authz_actions = {"run": "create"}
    serializer_class = MrpRunRequestSerializer
    pagination_class = None

    def get_queryset(self):
        from apps.procurement.mrp import MrpRun

        return pdp.filter_queryset(self.actor, "procurement.mrp.read", MrpRun.objects.order_by("-run_at"))

    @extend_schema(
        responses=inline_serializer(
            "MrpLatest", {"run": serializers.DictField(allow_null=True), "suggestions": serializers.ListField()}
        )
    )
    def list(self, request):
        from apps.procurement.mrp import MrpSuggestion

        run = self.get_queryset().first()
        if run is None:
            return Response({"run": None, "suggestions": []})
        rows = MrpSuggestion.objects.filter(run=run).select_related("item").order_by("item__code")
        return Response(
            {
                "run": {"id": str(run.pk), "run_at": run.run_at},
                "suggestions": [
                    {
                        "id": str(s.pk),
                        "item_id": str(s.item_id),
                        "item_code": s.item.code,
                        "action": s.action,
                        "on_hand": s.on_hand,
                        "open_supply": s.open_supply,
                        "demand": s.demand,
                        "reorder_level": s.reorder_level,
                        "suggested_quantity": s.suggested_quantity,
                        "status": s.status,
                    }
                    for s in rows
                ],
            }
        )

    @extend_schema(
        request=MrpRunRequestSerializer, responses=inline_serializer("MrpRun", {"id": serializers.UUIDField()})
    )
    @action(detail=False, methods=["post"])
    def run(self, request):
        from apps.organization.models import Company
        from apps.procurement.mrp import run_mrp

        v = self.validated(MrpRunRequestSerializer)
        result = run_mrp(self.actor, Company.objects.get(pk=self.actor.company_id), v["horizon_days"])
        return Response({"id": str(result.pk), "suggestions": result.suggestions.count()})
