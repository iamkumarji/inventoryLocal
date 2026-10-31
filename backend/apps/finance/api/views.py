from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization import pdp
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet
from apps.core.exceptions import NotFound
from apps.core.idempotency import idempotency_header, idempotent
from apps.finance import reports, services
from apps.finance.models import Account, AccountDetermination, CostCenter, JournalEntry
from apps.finance.posting import reverse_journal
from apps.organization.models import Company
from apps.shared.viewsets import MasterDataViewSet, master_schema

from . import serializers as s


@master_schema
class AccountViewSet(MasterDataViewSet):
    authz_resource = "finance.account"
    queryset = Account.objects.all()
    serializer_class = s.AccountSerializer
    editable_fields = ("name", "parent", "is_active", "is_control")
    filterset_fields = ["account_type", "sub_type", "is_group", "is_active"]
    search_fields = ["code", "name"]
    pagination_class = None

    @extend_schema(
        request=None, responses=inline_serializer("ChartInstalled", {"accounts": serializers.IntegerField()})
    )
    @action(detail=False, methods=["post"], url_path="install-template")
    def install_template(self, request):
        company = Company.objects.get(pk=self.actor.company_id)
        return Response({"accounts": services.install_chart(self.actor, company)})


@master_schema
class CostCenterViewSet(MasterDataViewSet):
    authz_resource = "finance.cost_center"
    queryset = CostCenter.objects.all()
    serializer_class = s.CostCenterSerializer
    editable_fields = ("name", "parent", "department", "is_active")


@master_schema
class PostingRuleViewSet(MasterDataViewSet):
    authz_resource = "finance.posting_rule"
    queryset = AccountDetermination.objects.select_related("account")
    serializer_class = s.PostingRuleSerializer
    editable_fields = ("account", "is_active")
    filterset_fields = ["key", "posting_group", "warehouse_type"]
    ordering = ["key", "posting_group", "warehouse_type"]
    pagination_class = None


class JournalEntryViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "finance.journal_entry"
    authz_actions = {"post_entry": "post", "reverse": "cancel"}
    queryset = JournalEntry.objects.prefetch_related("lines__account", "lines__partner").order_by(
        "-entry_date", "-number"
    )
    serializer_class = s.JournalEntrySerializer
    filterset_fields = {
        "status": ["exact"],
        "source_module": ["exact"],
        "source_type": ["exact"],
        "source_id": ["exact"],
        "entry_date": ["gte", "lte"],
    }
    search_fields = ["number", "narration"]

    @extend_schema(request=s.ManualJournalSerializer, responses={201: s.JournalEntrySerializer})
    def create(self, request):
        data = s.ManualJournalSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        v = data.validated_data
        lines = [
            {
                "amount": line["debit"] - line["credit"],
                "account": line["account"],
                "cost_center_id": line["cost_center"].pk if line.get("cost_center") else None,
                "partner_id": line.get("partner"),
                "description": line["description"],
            }
            for line in v["lines"]
        ]
        entry = services.create_manual_journal(
            self.actor, company=v["company"], entry_date=v["entry_date"], narration=v["narration"], lines=lines
        )
        return Response(
            s.JournalEntrySerializer(self.get_queryset().get(pk=entry.pk)).data, status=status.HTTP_201_CREATED
        )

    @extend_schema(
        request=s.JournalVersionSerializer, responses=s.JournalEntrySerializer, parameters=[idempotency_header(True)]
    )
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_entry(self, request, pk=None):
        entry = services.post_manual_journal(self.actor, self.get_object(), request.data.get("version"))
        return Response(s.JournalEntrySerializer(self.get_queryset().get(pk=entry.pk)).data)

    @extend_schema(request=s.ReverseSerializer, responses=s.JournalEntrySerializer)
    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        data = s.ReverseSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        entry = self.get_object()
        pdp.require(self.actor, "finance.journal_entry.cancel", pdp.Resource.of(entry))
        reversal = reverse_journal(self.actor, entry, **data.validated_data)
        return Response(s.JournalEntrySerializer(self.get_queryset().get(pk=reversal.pk)).data)


REPORT_PARAMS = [OpenApiParameter("date_from", str, required=True), OpenApiParameter("date_to", str, required=True)]
REPORT_RESPONSE = inline_serializer("FinancialReport", {"rows": serializers.ListField()})


class _ReportView(APIView):
    authz_resource = "finance.report"
    authz_actions = {"get": "read"}

    def company_id(self, request):
        ctx = actor_for(request)
        if ctx.company_id is None:
            raise NotFound("Choose a company first.")
        pdp.require(ctx, "finance.report.read", pdp.Resource.ref("finance.report", company_id=ctx.company_id))
        return ctx.company_id

    def period(self, request):
        data = s.PeriodQuery(data=request.query_params)
        data.is_valid(raise_exception=True)
        return data.validated_data["date_from"], data.validated_data["date_to"]


class TrialBalanceView(_ReportView):
    @extend_schema(parameters=REPORT_PARAMS, responses=REPORT_RESPONSE)
    def get(self, request):
        return Response(reports.trial_balance(self.company_id(request), *self.period(request)))


class ProfitAndLossView(_ReportView):
    @extend_schema(parameters=REPORT_PARAMS, responses=REPORT_RESPONSE)
    def get(self, request):
        return Response(reports.profit_and_loss(self.company_id(request), *self.period(request)))


class BalanceSheetView(_ReportView):
    @extend_schema(parameters=[OpenApiParameter("as_of", str, required=True)], responses=REPORT_RESPONSE)
    def get(self, request):
        data = serializers.DateField().to_internal_value(request.query_params.get("as_of", ""))
        return Response(reports.balance_sheet(self.company_id(request), data))


class AccountLedgerView(_ReportView):
    @extend_schema(parameters=REPORT_PARAMS, responses=REPORT_RESPONSE)
    def get(self, request, account_id):
        company_id = self.company_id(request)
        account = Account.objects.filter(pk=account_id, company_id=company_id).first()
        if account is None:
            raise NotFound()
        return Response(reports.account_ledger(account, *self.period(request)))
