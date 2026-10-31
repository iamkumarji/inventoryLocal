from decimal import Decimal

from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization import pdp
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPReadOnlyViewSet, ScopedPrimaryKeyRelatedField
from apps.core.exceptions import NotFound
from apps.core.idempotency import idempotency_header, idempotent
from apps.finance import gst, subledger
from apps.finance.models import (
    Account,
    BankAccount,
    BankStatementLine,
    Budget,
    BudgetLine,
    CostCenter,
    JournalLine,
    OpenItem,
    Payment,
    PaymentAllocation,
    SupplierInvoice,
    SupplierInvoiceLine,
)
from apps.organization.models import Company, FiscalPeriod, FiscalYear
from apps.partners.models import Partner
from apps.procurement.models import GoodsReceiptLine, PurchaseOrderLine
from apps.shared import workflow
from apps.shared.docviews import DecisionBody, DocumentViewSet, VersionBody
from apps.shared.viewsets import MasterDataViewSet, master_schema

from .fields import company_pk, organization_pk

IDEM = idempotency_header(True)


def company_field(action):
    return ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action=action)


class OpenItemSerializer(serializers.ModelSerializer):
    partner_name = serializers.CharField(source="partner.name", read_only=True)
    outstanding = serializers.DecimalField(max_digits=20, decimal_places=4, read_only=True)

    class Meta:
        model = OpenItem
        fields = [
            "id",
            "partner",
            "partner_name",
            "kind",
            "document_type",
            "document_id",
            "number",
            "document_date",
            "due_date",
            "amount",
            "settled",
            "outstanding",
            "is_open",
        ]
        read_only_fields = fields


class SupplierInvoiceLineSerializer(serializers.ModelSerializer):
    grn_line = company_pk(GoodsReceiptLine.objects.all(), "receipt__company_id", required=False, allow_null=True)
    po_line = company_pk(PurchaseOrderLine.objects.all(), "order__company_id", required=False)

    class Meta:
        model = SupplierInvoiceLine
        fields = ["id", "grn_line", "po_line", "quantity", "rate", "gst_rate", "taxable_amount", "cgst", "sgst", "igst"]
        read_only_fields = ["id", "gst_rate", "taxable_amount", "cgst", "sgst", "igst"]

    def validate(self, attrs):
        if not attrs.get("grn_line") and not attrs.get("po_line"):
            raise serializers.ValidationError("Give the goods receipt line (stock) or the order line (services).")
        return attrs


class SupplierInvoiceSerializer(serializers.ModelSerializer):
    company = company_field("finance.supplier_invoice.read")
    supplier = organization_pk(Partner.objects.filter(is_supplier=True))
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    lines = SupplierInvoiceLineSerializer(many=True)

    class Meta:
        model = SupplierInvoice
        fields = [
            "id",
            "number",
            "status",
            "version",
            "company",
            "supplier",
            "supplier_name",
            "supplier_invoice_number",
            "invoice_date",
            "due_date",
            "purchase_order",
            "intra_state",
            "match_status",
            "match_notes",
            "subtotal",
            "cgst",
            "sgst",
            "igst",
            "amount",
            "journal_entry",
            "created_at",
            "lines",
        ]
        read_only_fields = [
            "id",
            "number",
            "status",
            "version",
            "due_date",
            "intra_state",
            "match_status",
            "match_notes",
            "subtotal",
            "cgst",
            "sgst",
            "igst",
            "amount",
            "journal_entry",
            "created_at",
        ]


class AllocationSerializer(serializers.ModelSerializer):
    open_item = company_pk(OpenItem.objects.filter(is_open=True))
    number = serializers.CharField(source="open_item.number", read_only=True)

    class Meta:
        model = PaymentAllocation
        fields = ["open_item", "number", "amount"]


class PaymentSerializer(serializers.ModelSerializer):
    company = company_field("finance.payment.read")
    partner = organization_pk(Partner.objects.all())
    bank_account = company_pk(BankAccount.objects.filter(is_active=True))
    partner_name = serializers.CharField(source="partner.name", read_only=True)
    allocations = AllocationSerializer(many=True)

    class Meta:
        model = Payment
        fields = [
            "id",
            "number",
            "status",
            "version",
            "company",
            "kind",
            "partner",
            "partner_name",
            "bank_account",
            "payment_date",
            "mode",
            "reference",
            "amount",
            "submitted_by",
            "approved_by",
            "journal_entry",
            "created_at",
            "allocations",
        ]
        read_only_fields = [
            "id",
            "number",
            "status",
            "version",
            "submitted_by",
            "approved_by",
            "journal_entry",
            "created_at",
        ]


class CompanyBankAccountSerializer(serializers.ModelSerializer):
    company = company_field("finance.bank_account.read")
    account = company_pk(Account.objects.filter(sub_type__in=["bank", "cash"]))

    class Meta:
        model = BankAccount
        fields = ["id", "version", "company", "account", "bank_name", "ifsc", "account_last4", "is_active"]
        read_only_fields = ["id", "version"]
        validators: list = []


class StatementLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = BankStatementLine
        fields = ["id", "txn_date", "description", "reference", "amount", "balance", "status", "matched_line"]
        read_only_fields = fields


class ImportSerializer(serializers.Serializer):
    csv = serializers.CharField()


class MatchSerializer(serializers.Serializer):
    statement_line = company_pk(BankStatementLine.objects.filter(status="unmatched"))
    journal_line = company_pk(JournalLine.objects.filter(entry__status="posted"), "entry__company_id")


class ApplyCreditSerializer(serializers.Serializer):
    credit = company_pk(OpenItem.objects.filter(is_open=True))
    debit = company_pk(OpenItem.objects.filter(is_open=True))
    amount = serializers.DecimalField(max_digits=20, decimal_places=4)

    def validate(self, attrs):
        request = self.context.get("request")
        company_id = actor_for(request).company_id if request else None
        if attrs["credit"].company_id != company_id or attrs["debit"].company_id != company_id:
            raise serializers.ValidationError("Open items must belong to the active company.")
        return attrs


class OpenItemViewSet(ERPReadOnlyViewSet):
    authz_resource = "finance.open_item"
    authz_actions = {"ageing": "read", "apply_credit": "finance.payment.create"}
    queryset = OpenItem.objects.select_related("partner").order_by("due_date")
    serializer_class = OpenItemSerializer
    filterset_fields = ["kind", "partner", "is_open"]
    search_fields = ["number", "partner__name"]

    @extend_schema(
        parameters=[OpenApiParameter("kind", str, required=True), OpenApiParameter("as_of", str)],
        responses=inline_serializer("PartnerAgeing", {"total": serializers.DecimalField(20, 4)}, many=True),
    )
    @action(detail=False, methods=["get"], pagination_class=None)
    def ageing(self, request):
        as_of = serializers.DateField().to_internal_value(
            request.query_params.get("as_of") or str(timezone.localdate())
        )
        return Response(subledger.ageing(self.actor.company_id, request.query_params.get("kind", "receivable"), as_of))

    @extend_schema(request=ApplyCreditSerializer, responses=OpenItemSerializer(many=True))
    @action(detail=False, methods=["post"], url_path="apply-credit", pagination_class=None)
    @idempotent()
    def apply_credit(self, request):
        data = ApplyCreditSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        v = data.validated_data
        subledger.apply_credit(self.actor, credit=v["credit"], debit=v["debit"], amount=v["amount"])
        items = OpenItem.objects.filter(pk__in=[v["credit"].pk, v["debit"].pk]).select_related("partner")
        return Response(OpenItemSerializer(items, many=True).data)


class SupplierInvoiceViewSet(DocumentViewSet):
    authz_resource = subledger.AP_INVOICE
    authz_actions = {"submit": "update", "decide": "approve", "post_document": "post"}
    queryset = SupplierInvoice.objects.select_related("supplier").prefetch_related("lines").order_by("-created_at")
    serializer_class = SupplierInvoiceSerializer
    filterset_fields = ["status", "match_status", "supplier"]
    search_fields = ["number", "supplier_invoice_number", "supplier__name"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(subledger.create_supplier_invoice(self.actor, **v), created=True)

    @extend_schema(request=VersionBody, responses=SupplierInvoiceSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.respond(subledger.submit_supplier_invoice(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DecisionBody, responses=SupplierInvoiceSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            workflow.decide_directly(
                self.actor,
                self.get_object(),
                document_type=subledger.AP_INVOICE,
                approve=v["approve"],
                comment=v["comment"],
            )
        )

    @extend_schema(request=VersionBody, responses=SupplierInvoiceSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        return self.respond(subledger.post_supplier_invoice(self.actor, self.get_object(), self.version()))


class PaymentViewSet(DocumentViewSet):
    authz_resource = subledger.PAYMENT
    authz_actions = {"submit": "update", "decide": "approve", "post_document": "post"}
    queryset = (
        Payment.objects.select_related("partner").prefetch_related("allocations__open_item").order_by("-created_at")
    )
    serializer_class = PaymentSerializer
    filterset_fields = ["status", "kind", "partner", "mode"]
    search_fields = ["number", "reference", "partner__name"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(subledger.create_payment(self.actor, **v), created=True)

    @extend_schema(request=VersionBody, responses=PaymentSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.respond(subledger.submit_payment(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DecisionBody, responses=PaymentSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            workflow.decide_directly(
                self.actor,
                self.get_object(),
                document_type=subledger.PAYMENT,
                approve=v["approve"],
                comment=v["comment"],
            )
        )

    @extend_schema(request=VersionBody, responses=PaymentSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_document(self, request, pk=None):
        return self.respond(subledger.post_payment(self.actor, self.get_object(), self.version()))


@master_schema
class BankAccountViewSet(MasterDataViewSet):
    authz_resource = "finance.bank_account"
    authz_actions = {"statement": "read", "import_statement": "update", "match": "update", "reconciliation": "read"}
    queryset = BankAccount.objects.all()
    serializer_class = CompanyBankAccountSerializer
    editable_fields = ("bank_name", "ifsc", "account_last4", "is_active")
    ordering = ["bank_name"]

    @extend_schema(responses=StatementLineSerializer(many=True))
    @action(detail=True, methods=["get"], pagination_class=None)
    def statement(self, request, pk=None):
        lines = self.get_object().statement_lines.order_by("-txn_date")[:500]
        return Response(StatementLineSerializer(lines, many=True).data)

    @extend_schema(
        request=ImportSerializer, responses=inline_serializer("Imported", {"imported": serializers.IntegerField()})
    )
    @action(detail=True, methods=["post"], url_path="import-statement")
    def import_statement(self, request, pk=None):
        data = ImportSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return Response(subledger.import_statement(self.actor, self.get_object(), data.validated_data["csv"]))

    @extend_schema(request=MatchSerializer, responses=StatementLineSerializer)
    @action(detail=True, methods=["post"])
    def match(self, request, pk=None):
        self.get_object()
        data = MatchSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        line = subledger.manual_match(
            self.actor, data.validated_data["statement_line"], data.validated_data["journal_line"]
        )
        return Response(StatementLineSerializer(line).data)

    @extend_schema(
        parameters=[OpenApiParameter("as_of", str)],
        responses=inline_serializer("Reconciliation", {"book_balance": serializers.DecimalField(20, 4)}),
    )
    @action(detail=True, methods=["get"])
    def reconciliation(self, request, pk=None):
        as_of = serializers.DateField().to_internal_value(
            request.query_params.get("as_of") or str(timezone.localdate())
        )
        return Response(subledger.reconciliation(self.get_object(), as_of))


class _CompanyReport(APIView):
    permission_code = ""
    authz_resource = "finance.report"
    authz_actions = {"get": "read", "post": "read"}

    def company(self, request):
        ctx = actor_for(request)
        if ctx.company_id is None:
            raise NotFound("Choose a company first.")
        resource_type = self.permission_code.rsplit(".", 1)[0]
        pdp.require(ctx, self.permission_code, pdp.Resource.ref(resource_type, company_id=ctx.company_id))
        return ctx

    def dates(self, request):
        f = serializers.DateField()
        return f.to_internal_value(request.query_params.get("date_from", "")), f.to_internal_value(
            request.query_params.get("date_to", "")
        )


PERIOD = [OpenApiParameter("date_from", str, required=True), OpenApiParameter("date_to", str, required=True)]
ANY = inline_serializer("ReportData", {"data": serializers.DictField()})


class Gstr1View(_CompanyReport):
    permission_code = "finance.gst.read"

    @extend_schema(parameters=PERIOD, responses=ANY)
    def get(self, request):
        return Response(gst.gstr1(self.company(request).company_id, *self.dates(request)))


class Gstr3bView(_CompanyReport):
    permission_code = "finance.gst.read"

    @extend_schema(parameters=PERIOD, responses=ANY)
    def get(self, request):
        return Response(gst.gstr3b(self.company(request).company_id, *self.dates(request)))


class SubledgerCheckView(_CompanyReport):
    permission_code = "finance.period.read"

    @extend_schema(parameters=[OpenApiParameter("as_of", str)], responses=ANY)
    def get(self, request):
        as_of = serializers.DateField().to_internal_value(
            request.query_params.get("as_of") or str(timezone.localdate())
        )
        return Response(subledger.subledger_reconciliation(self.company(request).company_id, as_of))


class ClosePeriodView(_CompanyReport):
    permission_code = "finance.period.manage"
    authz_actions = {"post": "read"}

    @extend_schema(
        request=inline_serializer(
            "ClosePeriod", {"period": serializers.UUIDField(), "force": serializers.BooleanField(default=False)}
        ),
        responses=ANY,
    )
    def post(self, request):
        ctx = self.company(request)
        period = FiscalPeriod.objects.filter(
            pk=request.data.get("period"), fiscal_year__company_id=ctx.company_id
        ).first()
        if period is None:
            raise NotFound()
        return Response(subledger.close_period(ctx, period, force=bool(request.data.get("force"))))


class CloseYearView(_CompanyReport):
    permission_code = "finance.period.manage"
    authz_actions = {"post": "read"}

    @extend_schema(request=inline_serializer("CloseYear", {"fiscal_year": serializers.UUIDField()}), responses=ANY)
    def post(self, request):
        ctx = self.company(request)
        fy = FiscalYear.objects.filter(pk=request.data.get("fiscal_year"), company_id=ctx.company_id).first()
        if fy is None:
            raise NotFound()
        return Response(subledger.close_fiscal_year(ctx, fy))


class BudgetVsActualView(_CompanyReport):
    permission_code = "finance.budget.read"

    @extend_schema(responses=ANY)
    def get(self, request, budget_id):
        ctx = self.company(request)
        budget = Budget.objects.filter(pk=budget_id, company_id=ctx.company_id).first()
        if budget is None:
            raise NotFound()
        return Response(subledger.budget_vs_actual(budget))


class BudgetLineSerializer(serializers.ModelSerializer):
    account = company_pk(Account.objects.all())
    cost_center = company_pk(CostCenter.objects.all(), required=False, allow_null=True)
    account_code = serializers.CharField(source="account.code", read_only=True)

    class Meta:
        model = BudgetLine
        fields = ["id", "account", "account_code", "cost_center", "period_no", "amount"]
        read_only_fields = ["id", "account_code"]


class BudgetSerializer(serializers.ModelSerializer):
    lines = BudgetLineSerializer(many=True)
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="finance.budget.read")
    fiscal_year = company_pk(FiscalYear.objects.all())
    total = serializers.SerializerMethodField()

    class Meta:
        model = Budget
        fields = [
            "id",
            "version",
            "company",
            "fiscal_year",
            "name",
            "status",
            "lines",
            "total",
            "created_by",
            "updated_by",
            "created_at",
        ]
        read_only_fields = ["id", "version", "status", "total", "created_by", "updated_by", "created_at"]

    def get_total(self, obj) -> str:
        return str(sum((line.amount for line in obj.lines.all()), Decimal("0")))


class BudgetUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, required=False)
    lines = BudgetLineSerializer(many=True, required=False)
    version = serializers.IntegerField()


class BudgetViewSet(DocumentViewSet):
    """Budgets are prepared as drafts and approved by someone else; only approved ones count in variance."""

    authz_resource = subledger.BUDGET
    authz_actions = {"approve": "approve"}
    queryset = Budget.objects.select_related("fiscal_year").prefetch_related("lines__account").order_by("-created_at")
    serializer_class = BudgetSerializer
    filterset_fields = ["status", "fiscal_year"]
    search_fields = ["name"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(subledger.create_budget(self.actor, **v), created=True)

    @extend_schema(request=BudgetUpdateSerializer, responses=BudgetSerializer)
    def partial_update(self, request, pk=None):
        v = dict(self.validated(BudgetUpdateSerializer))
        return self.respond(
            subledger.update_budget(
                self.actor, self.get_object(), name=v.get("name"), lines=v.get("lines"), expected_version=v["version"]
            )
        )

    @extend_schema(request=VersionBody, responses=BudgetSerializer)
    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        return self.respond(subledger.approve_budget(self.actor, self.get_object(), self.version()))
