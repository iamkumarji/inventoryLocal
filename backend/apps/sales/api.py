from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter

from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.core.idempotency import idempotency_header, idempotent
from apps.masterdata.models import Item, Uom
from apps.organization.models import Branch, Company, Warehouse
from apps.partners.models import Partner
from apps.sales import services
from apps.sales.models import (
    Delivery,
    DeliveryLine,
    SalesInvoice,
    SalesInvoiceLine,
    SalesOrder,
    SalesOrderLine,
    SalesQuotation,
    SalesQuotationLine,
    SalesReturn,
    SalesReturnLine,
)
from apps.shared.docviews import DocumentViewSet, VersionBody

IDEM = idempotency_header(True)
PRICED = [
    "id",
    "item",
    "item_code",
    "quantity",
    "uom",
    "rate",
    "discount_pct",
    "gst_rate",
    "taxable_amount",
    "cgst",
    "sgst",
    "igst",
]
PRICED_RO = ["id", "item_code", "gst_rate", "taxable_amount", "cgst", "sgst", "igst"]


class OrgPK(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get("request")
        qs = super().get_queryset()
        return qs.none() if request is None else qs.filter(organization_id=request.user.organization_id)


class SalesQuoteLineSerializer(serializers.ModelSerializer):
    item = OrgPK(queryset=Item.objects.filter(is_saleable=True))
    uom = OrgPK(queryset=Uom.objects.all())
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = SalesQuotationLine
        fields = PRICED
        read_only_fields = PRICED_RO


class SalesQuotationSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="sales.quotation.read")
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.all())
    customer = OrgPK(queryset=Partner.objects.filter(is_customer=True))
    lines = SalesQuoteLineSerializer(many=True)

    class Meta:
        model = SalesQuotation
        fields = [
            "id",
            "number",
            "status",
            "version",
            "company",
            "branch",
            "customer",
            "quote_date",
            "valid_until",
            "intra_state",
            "amount",
            "notes",
            "lines",
        ]
        read_only_fields = ["id", "number", "status", "version", "intra_state", "amount"]


class SalesOrderLineSerializer(serializers.ModelSerializer):
    item = OrgPK(queryset=Item.objects.filter(is_saleable=True))
    uom = OrgPK(queryset=Uom.objects.all())
    warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.filter(is_active=True))
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = SalesOrderLine
        fields = [
            *PRICED,
            "line_no",
            "warehouse",
            "stock_quantity",
            "reserved_quantity",
            "delivered_quantity",
            "invoiced_quantity",
            "returned_quantity",
        ]
        read_only_fields = [
            *PRICED_RO,
            "line_no",
            "stock_quantity",
            "reserved_quantity",
            "delivered_quantity",
            "invoiced_quantity",
            "returned_quantity",
        ]


class SalesOrderSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="sales.sales_order.read")
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.all())
    customer = OrgPK(queryset=Partner.objects.filter(is_customer=True))
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    lines = SalesOrderLineSerializer(many=True)

    class Meta:
        model = SalesOrder
        fields = [
            "id",
            "number",
            "status",
            "credit_status",
            "credit_note",
            "version",
            "company",
            "branch",
            "customer",
            "customer_name",
            "customer_po",
            "order_date",
            "requested_date",
            "place_of_supply",
            "intra_state",
            "subtotal",
            "tax_total",
            "amount",
            "submitted_by",
            "approved_by",
            "created_at",
            "lines",
        ]
        read_only_fields = [
            "id",
            "number",
            "status",
            "credit_status",
            "credit_note",
            "version",
            "intra_state",
            "subtotal",
            "tax_total",
            "amount",
            "submitted_by",
            "approved_by",
            "created_at",
        ]


class SalesDeliveryLineSerializer(serializers.ModelSerializer):
    batch_number = serializers.CharField(write_only=True, required=False, allow_blank=True)
    item_code = serializers.CharField(source="so_line.item.code", read_only=True)

    class Meta:
        model = DeliveryLine
        fields = [
            "id",
            "so_line",
            "item_code",
            "quantity",
            "batch",
            "batch_number",
            "serials",
            "location",
            "cost_value",
        ]
        read_only_fields = ["id", "item_code", "batch", "cost_value"]


class SalesDeliverySerializer(serializers.ModelSerializer):
    sales_order = serializers.PrimaryKeyRelatedField(queryset=SalesOrder.objects.filter(status="approved"))
    warehouse = ScopedPrimaryKeyRelatedField(queryset=Warehouse.objects.all(), read_action="sales.delivery.read")
    lines = SalesDeliveryLineSerializer(many=True)

    class Meta:
        model = Delivery
        fields = [
            "id",
            "number",
            "status",
            "version",
            "sales_order",
            "customer",
            "warehouse",
            "delivery_date",
            "eway_bill_number",
            "stock_transaction",
            "lines",
        ]
        read_only_fields = ["id", "number", "status", "version", "customer", "stock_transaction", "eway_bill_number"]


class SalesInvoiceLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = SalesInvoiceLine
        fields = [
            "id",
            "so_line",
            "item",
            "hsn_code",
            "quantity",
            "rate",
            "gst_rate",
            "taxable_amount",
            "cgst",
            "sgst",
            "igst",
            "returned_quantity",
        ]
        read_only_fields = fields


class SalesInvoiceSerializer(serializers.ModelSerializer):
    lines = SalesInvoiceLineSerializer(many=True, read_only=True)
    customer_name = serializers.CharField(source="customer.name", read_only=True)

    class Meta:
        model = SalesInvoice
        fields = [
            "id",
            "number",
            "status",
            "version",
            "sales_order",
            "customer",
            "customer_name",
            "branch",
            "invoice_date",
            "due_date",
            "place_of_supply",
            "intra_state",
            "customer_gstin",
            "subtotal",
            "cgst",
            "sgst",
            "igst",
            "total",
            "irn",
            "journal_entry",
            "lines",
        ]
        read_only_fields = fields


class SalesInvoiceCreateSerializer(serializers.Serializer):
    sales_order = serializers.PrimaryKeyRelatedField(queryset=SalesOrder.objects.filter(status="approved"))
    invoice_date = serializers.DateField()


class SalesReturnLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = SalesReturnLine
        fields = ["id", "invoice_line", "quantity", "restock", "batch", "serials"]
        read_only_fields = ["id"]


class SalesReturnSerializer(serializers.ModelSerializer):
    invoice = serializers.PrimaryKeyRelatedField(queryset=SalesInvoice.objects.filter(status="posted"))
    warehouse = ScopedPrimaryKeyRelatedField(queryset=Warehouse.objects.all(), read_action="sales.sales_return.read")
    lines = SalesReturnLineSerializer(many=True)

    class Meta:
        model = SalesReturn
        fields = [
            "id",
            "number",
            "status",
            "version",
            "invoice",
            "customer",
            "warehouse",
            "return_date",
            "reason",
            "credit_total",
            "lines",
        ]
        read_only_fields = ["id", "number", "status", "version", "customer", "credit_total"]


class CreditDecision(serializers.Serializer):
    approve = serializers.BooleanField()
    note = serializers.CharField()


class SubmitBody(serializers.Serializer):
    version = serializers.IntegerField(required=False)
    on = serializers.DateField(required=False)


class ConvertBody(serializers.Serializer):
    warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.filter(is_active=True))
    order_date = serializers.DateField()
    requested_date = serializers.DateField()


class QuotationViewSet(DocumentViewSet):
    authz_resource = "sales.quotation"
    authz_actions = {"convert": "sales.sales_order.create"}
    queryset = SalesQuotation.objects.prefetch_related("lines__item").order_by("-created_at")
    serializer_class = SalesQuotationSerializer
    filterset_fields = ["status", "customer", "branch"]

    def create(self, request):
        return self.respond(services.create_quotation(self.actor, **dict(self.validated())), created=True)

    @extend_schema(request=ConvertBody, responses=SalesOrderSerializer)
    @action(detail=True, methods=["post"])
    def convert(self, request, pk=None):
        v = self.validated(ConvertBody)
        order = services.convert_quotation(self.actor, self.get_object(), **v)
        return Response(SalesOrderSerializer(SalesOrder.objects.get(pk=order.pk)).data)


class SalesOrderViewSet(DocumentViewSet):
    authz_resource = services.SO
    authz_actions = {"submit": "update", "credit": "credit_override", "fefo": "read"}
    queryset = SalesOrder.objects.select_related("customer").prefetch_related("lines__item").order_by("-created_at")
    serializer_class = SalesOrderSerializer
    filterset_fields = ["status", "credit_status", "customer", "branch"]
    search_fields = ["number", "customer__name", "customer_po"]

    def create(self, request):
        return self.respond(services.create_order(self.actor, **dict(self.validated())), created=True)

    @extend_schema(request=SubmitBody, responses=SalesOrderSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        from django.utils import timezone

        v = self.validated(SubmitBody)
        return self.respond(
            services.submit_order(
                self.actor, self.get_object(), on=v.get("on") or timezone.localdate(), expected_version=v.get("version")
            )
        )

    @extend_schema(request=CreditDecision, responses=SalesOrderSerializer)
    @action(detail=True, methods=["post"])
    def credit(self, request, pk=None):
        v = self.validated(CreditDecision)
        return self.respond(services.decide_credit(self.actor, self.get_object(), **v))

    @extend_schema(
        parameters=[OpenApiParameter("line", str, required=True)],
        responses=inline_serializer("FefoBatch", {"batch_number": serializers.CharField()}, many=True),
    )
    @action(detail=True, methods=["get"], pagination_class=None)
    def fefo(self, request, pk=None):
        order = self.get_object()
        line = order.lines.get(pk=request.query_params.get("line"))
        return Response(services.fefo_batches(order.company_id, line.item, line.warehouse))


class DeliveryViewSet(DocumentViewSet):
    authz_resource = "sales.delivery"
    authz_actions = {"post_document": "post"}
    queryset = Delivery.objects.prefetch_related("lines__so_line__item").order_by("-created_at")
    serializer_class = SalesDeliverySerializer
    filterset_fields = ["status", "warehouse", "sales_order"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_delivery(self.actor, order=v.pop("sales_order"), **v), created=True)

    @extend_schema(request=VersionBody, responses=SalesDeliverySerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        return self.respond(services.post_delivery(self.actor, self.get_object(), self.version()))


class InvoiceViewSet(DocumentViewSet):
    authz_resource = "sales.invoice"
    authz_actions = {"post_document": "post"}
    queryset = SalesInvoice.objects.select_related("customer").prefetch_related("lines").order_by("-created_at")
    serializer_class = SalesInvoiceSerializer
    filterset_fields = ["status", "customer", "branch"]
    search_fields = ["number", "customer__name"]

    @extend_schema(request=SalesInvoiceCreateSerializer, responses={201: SalesInvoiceSerializer})
    def create(self, request):
        v = self.validated(SalesInvoiceCreateSerializer)
        return self.respond(
            services.create_invoice(self.actor, order=v["sales_order"], invoice_date=v["invoice_date"]), created=True
        )

    @extend_schema(request=VersionBody, responses=SalesInvoiceSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        return self.respond(services.post_invoice(self.actor, self.get_object(), self.version()))


class ReturnViewSet(DocumentViewSet):
    authz_resource = "sales.sales_return"
    authz_actions = {"post_document": "post"}
    queryset = SalesReturn.objects.prefetch_related("lines").order_by("-created_at")
    serializer_class = SalesReturnSerializer
    filterset_fields = ["status", "customer"]

    def create(self, request):
        return self.respond(services.create_return(self.actor, **dict(self.validated())), created=True)

    @extend_schema(request=VersionBody, responses=SalesReturnSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        return self.respond(services.post_return(self.actor, self.get_object(), self.version()))


router = SimpleRouter()
router.register("sales/quotations", QuotationViewSet, basename="sales-quotation")
router.register("sales/orders", SalesOrderViewSet, basename="sales-order")
router.register("sales/deliveries", DeliveryViewSet, basename="delivery")
router.register("sales/invoices", InvoiceViewSet, basename="sales-invoice")
router.register("sales/returns", ReturnViewSet, basename="sales-return")
urlpatterns = router.urls
