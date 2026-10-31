"""Expenses API: thin views over `apps.expenses.services`. Every view declares its authorization."""

from django.db.models import Q
from django.urls import path
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter
from rest_framework.views import APIView

from apps.audit.models import AuditEvent
from apps.authorization.context import actor_for
from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.core.idempotency import idempotency_header, idempotent
from apps.finance.models import CostCenter
from apps.hr import services as hr
from apps.hr.api import OrgScopedPK, employee_field, require_module
from apps.organization.models import Branch, Company
from apps.shared.docviews import DecisionBody, DocumentViewSet, VersionBody
from apps.shared.viewsets import MasterDataViewSet, master_schema

from . import services
from .models import EmployeeAdvance, ExpenseCategory, ExpenseClaim, ExpenseClaimLine, FuelLog

IDEM = idempotency_header(True)
DOC = [
    "id",
    "number",
    "status",
    "version",
    "amount",
    "currency",
    "submitted_by",
    "approved_by",
    "created_by",
    "created_at",
]


def _rejection_reason(type_: str, doc) -> str:
    """The approver's comment on a rejected document (kept in the audit trail), so the employee can fix it."""
    if doc.status != "rejected":
        return ""
    event = (
        AuditEvent.objects.filter(action=f"{type_}.rejected", resource_type=type_, resource_id=str(doc.pk))
        .order_by("-occurred_at")
        .only("summary")
        .first()
    )
    return event.summary if event else ""


def _own_employee_or(ctx, employee):
    if employee is not None:
        return employee
    own = hr.employee_for_user(ctx.user, ctx.company_id)
    if own is None:
        raise serializers.ValidationError({"employee": ["No employee record is linked to your account; choose one."]})
    return own


# --- Categories ---------------------------------------------------------------------------------------


class CategorySerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action=f"{services.CATEGORY}.create")

    class Meta:
        model = ExpenseCategory
        fields = [
            "id",
            "version",
            "company",
            "code",
            "name",
            "gl_key",
            "per_claim_limit",
            "receipt_required_above",
            "requires_vehicle",
            "is_active",
        ]
        read_only_fields = ["id", "version"]
        validators: list = []

    def validate(self, attrs):
        company = attrs.get("company") or getattr(self.instance, "company", None)
        key = attrs.get("gl_key") or getattr(self.instance, "gl_key", None) or "expense_default"
        if company is not None:
            services.validate_gl_key(company.pk, key)
        return attrs


@master_schema
class CategoryViewSet(MasterDataViewSet):
    authz_resource = services.CATEGORY
    queryset = ExpenseCategory.objects.all()
    serializer_class = CategorySerializer
    editable_fields = ("name", "gl_key", "per_claim_limit", "receipt_required_above", "requires_vehicle", "is_active")
    filterset_fields = ["is_active", "requires_vehicle"]


# --- Claims -------------------------------------------------------------------------------------------------


class ClaimLineSerializer(serializers.ModelSerializer):
    category = OrgScopedPK(queryset=ExpenseCategory.objects.filter(is_active=True), org_path="company__organization_id")
    category_code = serializers.CharField(source="category.code", read_only=True)

    class Meta:
        model = ExpenseClaimLine
        fields = [
            "id",
            "line_no",
            "category",
            "category_code",
            "expense_date",
            "description",
            "amount",
            "receipt_reference",
            "vehicle_registration",
            "odometer",
            "litres",
        ]
        read_only_fields = ["id", "line_no", "category_code"]


class ClaimSerializer(serializers.ModelSerializer):
    employee = employee_field(f"{services.CLAIM}.create", required=False)
    employee_name = serializers.CharField(source="employee.full_name", read_only=True)
    branch = OrgScopedPK(
        queryset=Branch.objects.all(), org_path="company__organization_id", required=False, allow_null=True
    )
    cost_center = OrgScopedPK(
        queryset=CostCenter.objects.all(), org_path="company__organization_id", required=False, allow_null=True
    )
    advance = OrgScopedPK(
        queryset=EmployeeAdvance.objects.all(), org_path="company__organization_id", required=False, allow_null=True
    )
    lines = ClaimLineSerializer(many=True)
    rejection_reason = serializers.SerializerMethodField()

    class Meta:
        model = ExpenseClaim
        fields = [
            *DOC,
            "employee",
            "employee_name",
            "department",
            "branch",
            "cost_center",
            "claim_date",
            "purpose",
            "advance",
            "advance_settled",
            "net_payable",
            "lines",
            "approval_journal",
            "paid_by",
            "paid_on",
            "bank_reference",
            "payment_journal",
            "rejection_reason",
        ]
        read_only_fields = [
            *DOC,
            "employee_name",
            "department",
            "advance_settled",
            "net_payable",
            "approval_journal",
            "paid_by",
            "paid_on",
            "bank_reference",
            "payment_journal",
        ]

    def get_rejection_reason(self, obj) -> str:
        return _rejection_reason(services.CLAIM, obj)


class ClaimUpdateSerializer(serializers.Serializer):
    claim_date = serializers.DateField(required=False)
    purpose = serializers.CharField(max_length=300, required=False)
    branch = OrgScopedPK(
        queryset=Branch.objects.all(), org_path="company__organization_id", required=False, allow_null=True
    )
    cost_center = OrgScopedPK(
        queryset=CostCenter.objects.all(), org_path="company__organization_id", required=False, allow_null=True
    )
    advance = OrgScopedPK(
        queryset=EmployeeAdvance.objects.all(), org_path="company__organization_id", required=False, allow_null=True
    )
    lines = ClaimLineSerializer(many=True, required=False)
    version = serializers.IntegerField()


class PaySerializer(serializers.Serializer):
    paid_on = serializers.DateField()
    bank_reference = serializers.CharField(max_length=60)
    version = serializers.IntegerField(required=False)


class ClaimViewSet(DocumentViewSet):
    authz_resource = services.CLAIM
    authz_actions = {"submit": "update", "decide": "approve", "pay": "pay"}
    queryset = (
        ExpenseClaim.objects.select_related("employee").prefetch_related("lines__category").order_by("-created_at")
    )
    serializer_class = ClaimSerializer
    filterset_fields = ["status", "employee", "department", "branch"]
    search_fields = ["number", "purpose", "employee__code", "employee__full_name"]

    @idempotent()
    def create(self, request):
        v = dict(self.validated())
        v["employee"] = _own_employee_or(self.actor, v.get("employee"))
        return self.respond(services.create_claim(self.actor, **v), created=True)

    @extend_schema(
        request=ClaimUpdateSerializer,
        responses=ClaimSerializer,
        description="Edit a draft or rejected claim; `lines` replaces all lines. `version` is required.",
    )
    def partial_update(self, request, pk=None):
        claim = self.get_object()
        v = dict(self.validated(ClaimUpdateSerializer))
        version = v.pop("version")
        return self.respond(services.update_claim(self.actor, claim, v, version))

    @extend_schema(request=VersionBody, responses=ClaimSerializer)
    @action(detail=True, methods=["post"])
    @idempotent()
    def submit(self, request, pk=None):
        return self.respond(services.submit_claim(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DecisionBody, responses=ClaimSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            services.decide_claim(
                self.actor,
                self.get_object(),
                approve=v["approve"],
                comment=v["comment"],
                expected_version=v.get("version"),
            )
        )

    @extend_schema(request=PaySerializer, responses=ClaimSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def pay(self, request, pk=None):
        v = self.validated(PaySerializer)
        return self.respond(
            services.mark_paid(
                self.actor,
                self.get_object(),
                paid_on=v["paid_on"],
                bank_reference=v["bank_reference"],
                expected_version=v.get("version"),
            )
        )


class MyClaimsView(APIView):
    """Claims filed by or for the caller (self-service)."""

    authz_authenticated_only = True

    @extend_schema(responses=ClaimSerializer(many=True), tags=["expenses"])
    def get(self, request):
        ctx = actor_for(request)
        require_module(ctx, "expenses")
        mine = Q(created_by=request.user)
        if request.user.employee_id:
            mine |= Q(employee_id=request.user.employee_id)
        qs = (
            ExpenseClaim.objects.filter(mine)
            .select_related("employee")
            .prefetch_related("lines__category")
            .order_by("-created_at")[:200]
        )
        return Response(ClaimSerializer(qs, many=True, context={"request": request}).data)


# --- Fuel logs ---------------------------------------------------------------------------------------------------


class FuelLogSerializer(serializers.ModelSerializer):
    driver = employee_field(f"{services.FUEL}.create")
    driver_name = serializers.CharField(source="driver.full_name", read_only=True)

    class Meta:
        model = FuelLog
        fields = [
            "id",
            "vehicle_registration",
            "log_date",
            "odometer",
            "litres",
            "rate",
            "amount",
            "driver",
            "driver_name",
            "department",
            "claim_line",
            "remarks",
            "created_at",
        ]
        read_only_fields = ["id", "amount", "driver_name", "department", "claim_line", "created_at"]
        validators: list = []


class FuelLogViewSet(DocumentViewSet):
    authz_resource = services.FUEL
    queryset = FuelLog.objects.select_related("driver").order_by("-log_date", "-odometer")
    serializer_class = FuelLogSerializer
    filterset_fields = ["vehicle_registration", "driver", "department"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.record_fuel(self.actor, **v), created=True)


# --- Advances ---------------------------------------------------------------------------------------------------


class AdvanceSerializer(serializers.ModelSerializer):
    employee = employee_field(f"{services.ADVANCE}.create", required=False)
    employee_name = serializers.CharField(source="employee.full_name", read_only=True)
    branch = OrgScopedPK(
        queryset=Branch.objects.all(), org_path="company__organization_id", required=False, allow_null=True
    )
    outstanding = serializers.DecimalField(max_digits=20, decimal_places=4, read_only=True)
    rejection_reason = serializers.SerializerMethodField()

    class Meta:
        model = EmployeeAdvance
        fields = [
            *DOC,
            "employee",
            "employee_name",
            "department",
            "branch",
            "purpose",
            "settled_amount",
            "outstanding",
            "paid_by",
            "paid_on",
            "bank_reference",
            "payment_journal",
            "rejection_reason",
        ]
        read_only_fields = [f for f in DOC if f != "amount"] + [
            "employee_name",
            "department",
            "settled_amount",
            "outstanding",
            "paid_by",
            "paid_on",
            "bank_reference",
            "payment_journal",
        ]

    def get_rejection_reason(self, obj) -> str:
        return _rejection_reason(services.ADVANCE, obj)


class AdvanceViewSet(DocumentViewSet):
    authz_resource = services.ADVANCE
    authz_actions = {"decide": "approve", "pay": "pay"}
    queryset = EmployeeAdvance.objects.select_related("employee").order_by("-created_at")
    serializer_class = AdvanceSerializer
    filterset_fields = ["status", "employee", "department"]

    def create(self, request):
        v = dict(self.validated())
        v["employee"] = _own_employee_or(self.actor, v.get("employee"))
        return self.respond(services.request_advance(self.actor, **v), created=True)

    @extend_schema(request=DecisionBody, responses=AdvanceSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            services.decide_advance(
                self.actor,
                self.get_object(),
                approve=v["approve"],
                comment=v["comment"],
                expected_version=v.get("version"),
            )
        )

    @extend_schema(request=PaySerializer, responses=AdvanceSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"])
    @idempotent(required=True)
    def pay(self, request, pk=None):
        v = self.validated(PaySerializer)
        return self.respond(
            services.pay_advance(
                self.actor,
                self.get_object(),
                paid_on=v["paid_on"],
                bank_reference=v["bank_reference"],
                expected_version=v.get("version"),
            )
        )


class MyAdvancesView(APIView):
    """Advances requested by or for the caller (self-service), so they can be linked to a claim."""

    authz_authenticated_only = True

    @extend_schema(responses=AdvanceSerializer(many=True), tags=["expenses"])
    def get(self, request):
        ctx = actor_for(request)
        require_module(ctx, "expenses")
        mine = Q(created_by=request.user)
        if request.user.employee_id:
            mine |= Q(employee_id=request.user.employee_id)
        qs = EmployeeAdvance.objects.filter(mine).select_related("employee").order_by("-created_at")[:200]
        return Response(AdvanceSerializer(qs, many=True, context={"request": request}).data)


router = SimpleRouter()
router.register("expenses/categories", CategoryViewSet, basename="expense-category")
router.register("expenses/claims", ClaimViewSet, basename="expense-claim")
router.register("expenses/fuel-logs", FuelLogViewSet, basename="fuel-log")
router.register("expenses/advances", AdvanceViewSet, basename="employee-advance")

urlpatterns = [
    path("expenses/my/claims/", MyClaimsView.as_view(), name="expenses-my-claims"),
    path("expenses/my/advances/", MyAdvancesView.as_view(), name="expenses-my-advances"),
    *router.urls,
]
