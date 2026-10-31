"""HR API: thin views over `apps.hr.services`. Every view declares its authorization."""

from django.db import transaction
from django.urls import path
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter
from rest_framework.views import APIView

from apps.authorization.context import actor_for
from apps.authorization.drf import ERPReadOnlyViewSet, ScopedPrimaryKeyRelatedField
from apps.authorization.snapshot import get_snapshot
from apps.core import flags
from apps.core.exceptions import FeatureDisabled, NotFound
from apps.core.idempotency import idempotency_header, idempotent
from apps.identity.models import User
from apps.organization.models import Branch, Company, Department
from apps.shared.docviews import DecisionBody, DocumentViewSet, VersionBody
from apps.shared.viewsets import MasterDataViewSet, master_schema

from . import services
from .models import (
    AttendanceRecord,
    Employee,
    EmployeeSalary,
    EmployeeSalaryLine,
    LeaveBalance,
    LeaveRequest,
    LeaveType,
    PayrollRun,
    Payslip,
    PayslipLine,
    SalaryComponent,
    SalaryStructure,
    SalaryStructureLine,
)

IDEM = idempotency_header(True)


def require_module(ctx, module: str) -> None:
    """Self-service views skip the PDP, so they check the module feature flag themselves."""
    snapshot = get_snapshot(ctx.user.pk)
    if not flags.is_enabled(
        flags.module_flag_key(module),
        user_id=ctx.user.pk,
        role_codes=snapshot.role_codes,
        company_id=ctx.company_id,
        organization_id=ctx.user.organization_id,
    ):
        raise FeatureDisabled()


class OrgScopedPK(serializers.PrimaryKeyRelatedField):
    """FK limited to the caller's organization (authority is checked by the service)."""

    def __init__(self, *args, org_path: str = "organization_id", **kwargs):
        self.org_path = org_path
        super().__init__(*args, **kwargs)

    def get_queryset(self):
        request = self.context.get("request")
        qs = super().get_queryset()
        return qs.none() if request is None else qs.filter(**{self.org_path: request.user.organization_id})


def employee_field(action: str, **kwargs):
    """Employees in the scope where the caller may perform `action`."""
    return ScopedPrimaryKeyRelatedField(queryset=Employee.objects.all(), read_action=action, **kwargs)


# --- Employees -------------------------------------------------------------------------------------------


class EmployeeSerializer(serializers.ModelSerializer):
    department_name = serializers.CharField(source="department.name", read_only=True)
    pan_masked = serializers.SerializerMethodField()
    bank_account_masked = serializers.SerializerMethodField()
    aadhaar_masked = serializers.SerializerMethodField()

    class Meta:
        model = Employee
        fields = [
            "id",
            "version",
            "company",
            "code",
            "full_name",
            "department",
            "department_name",
            "branch",
            "user",
            "designation",
            "grade",
            "date_of_joining",
            "date_of_exit",
            "status",
            "work_email",
            "phone",
            "bank_ifsc",
            "pan_masked",
            "bank_account_masked",
            "aadhaar_masked",
            "created_at",
        ]
        read_only_fields = fields

    def _hints(self, obj) -> dict:
        cache = self.context.setdefault("_hints", {})
        if obj.pk not in cache:
            cache[obj.pk] = services.sensitive_hints(obj)
        return cache[obj.pk]

    def get_pan_masked(self, obj) -> str:
        return self._hints(obj)["pan_masked"]

    def get_bank_account_masked(self, obj) -> str:
        return self._hints(obj)["bank_account_masked"]

    def get_aadhaar_masked(self, obj) -> str:
        return self._hints(obj)["aadhaar_masked"]


class EmployeeWriteSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=30)
    full_name = serializers.CharField(max_length=200)
    department = OrgScopedPK(queryset=Department.objects.filter(is_active=True), org_path="company__organization_id")
    branch = OrgScopedPK(
        queryset=Branch.objects.all(), org_path="company__organization_id", required=False, allow_null=True
    )
    user = OrgScopedPK(queryset=User.objects.filter(is_active=True), required=False, allow_null=True)
    designation = serializers.CharField(max_length=120, required=False, allow_blank=True)
    grade = serializers.CharField(max_length=40, required=False, allow_blank=True)
    date_of_joining = serializers.DateField()
    work_email = serializers.EmailField(required=False, allow_blank=True)
    phone = serializers.CharField(max_length=30, required=False, allow_blank=True)
    bank_ifsc = serializers.CharField(max_length=11, required=False, allow_blank=True)
    pan = serializers.CharField(max_length=10, required=False, allow_blank=True, write_only=True)
    bank_account_number = serializers.CharField(max_length=20, required=False, allow_blank=True, write_only=True)
    aadhaar_last4 = serializers.CharField(max_length=4, required=False, allow_blank=True, write_only=True)


class EmployeeUpdateSerializer(EmployeeWriteSerializer):
    version = serializers.IntegerField()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields.pop("code")
        for f in self.fields.values():
            f.required = f.field_name == "version"


class ExitSerializer(serializers.Serializer):
    date_of_exit = serializers.DateField()
    version = serializers.IntegerField(required=False)


class EmployeeViewSet(DocumentViewSet):
    authz_resource = services.EMPLOYEE
    authz_actions = {"exit": "update"}
    queryset = Employee.objects.select_related("department").order_by("code")
    serializer_class = EmployeeSerializer
    filterset_fields = ["status", "department", "branch"]
    search_fields = ["code", "full_name", "designation"]

    @extend_schema(request=EmployeeWriteSerializer, responses={201: EmployeeSerializer})
    def create(self, request):
        v = dict(self.validated(EmployeeWriteSerializer))
        department = v["department"]
        return self.respond(services.create_employee(self.actor, company=department.company, **v), created=True)

    @extend_schema(
        request=EmployeeUpdateSerializer,
        responses=EmployeeSerializer,
        description="Partial update; `version` is required (optimistic locking).",
    )
    def partial_update(self, request, pk=None):
        employee = self.get_object()
        v = dict(self.validated(EmployeeUpdateSerializer))
        version = v.pop("version")
        return self.respond(services.update_employee(self.actor, employee, v, version))

    @extend_schema(request=ExitSerializer, responses=EmployeeSerializer)
    @action(detail=True, methods=["post"])
    def exit(self, request, pk=None):
        v = self.validated(ExitSerializer)
        return self.respond(
            services.exit_employee(
                self.actor, self.get_object(), date_of_exit=v["date_of_exit"], expected_version=v.get("version")
            )
        )


# --- Attendance --------------------------------------------------------------------------------------------


class AttendanceSerializer(serializers.ModelSerializer):
    employee = employee_field(f"{services.ATTENDANCE}.create")
    employee_code = serializers.CharField(source="employee.code", read_only=True)

    class Meta:
        model = AttendanceRecord
        fields = [
            "id",
            "employee",
            "employee_code",
            "date",
            "status",
            "check_in",
            "check_out",
            "source",
            "leave_type",
            "remarks",
            "updated_at",
        ]
        read_only_fields = ["id", "employee_code", "source", "leave_type", "updated_at"]
        validators: list = []


class AttendanceImportSerializer(serializers.Serializer):
    company = ScopedPrimaryKeyRelatedField(
        queryset=Company.objects.all(), read_action=f"{services.ATTENDANCE}.read", required=False
    )
    csv = serializers.CharField(help_text="CSV text: employee_code,date,status[,check_in,check_out,remarks]")
    overwrite = serializers.BooleanField(default=False)


AttendanceImportResult = inline_serializer(
    "AttendanceImportResult",
    {"rows": serializers.IntegerField(), "created": serializers.IntegerField(), "updated": serializers.IntegerField()},
)


class AttendanceViewSet(DocumentViewSet):
    authz_resource = services.ATTENDANCE
    authz_actions = {"import_csv": "create"}
    queryset = AttendanceRecord.objects.select_related("employee").order_by("-date", "employee__code")
    serializer_class = AttendanceSerializer
    filterset_fields = {"employee": ["exact"], "status": ["exact"], "date": ["exact", "gte", "lte"]}

    def create(self, request):
        v = dict(self.validated())
        v.pop("leave_type", None)
        return self.respond(services.record_attendance(self.actor, **v), created=True)

    @extend_schema(request=AttendanceImportSerializer, responses=AttendanceImportResult)
    @action(detail=False, methods=["post"], url_path="import")
    def import_csv(self, request):
        v = self.validated(AttendanceImportSerializer)
        company = v.get("company")
        if company is None:
            company = Company.objects.filter(pk=self.actor.company_id).first()
            if company is None:
                raise serializers.ValidationError({"company": ["Choose a company."]})
        result = services.import_attendance(self.actor, company=company, csv_text=v["csv"], overwrite=v["overwrite"])
        return Response(result)


# --- Leave ---------------------------------------------------------------------------------------------------


class LeaveTypeSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="hr.leave_type.create")

    class Meta:
        model = LeaveType
        fields = ["id", "version", "company", "code", "name", "is_paid", "annual_quota", "is_active"]
        read_only_fields = ["id", "version"]
        validators: list = []


@master_schema
class LeaveTypeViewSet(MasterDataViewSet):
    authz_resource = "hr.leave_type"
    queryset = LeaveType.objects.all()
    serializer_class = LeaveTypeSerializer
    editable_fields = ("name", "annual_quota", "is_active")
    filterset_fields = ["is_paid", "is_active"]


class LeaveBalanceSerializer(serializers.ModelSerializer):
    employee = employee_field(f"{services.LEAVE_BALANCE}.create")
    employee_code = serializers.CharField(source="employee.code", read_only=True)
    leave_type = OrgScopedPK(queryset=LeaveType.objects.filter(is_active=True), org_path="company__organization_id")
    allocated = serializers.DecimalField(max_digits=6, decimal_places=2, required=False, min_value=0)
    available = serializers.DecimalField(max_digits=6, decimal_places=2, read_only=True)

    class Meta:
        model = LeaveBalance
        fields = ["id", "version", "employee", "employee_code", "leave_type", "year", "allocated", "used", "available"]
        read_only_fields = ["id", "version", "employee_code", "used", "available"]
        validators: list = []


class LeaveBalanceViewSet(DocumentViewSet):
    authz_resource = services.LEAVE_BALANCE
    queryset = LeaveBalance.objects.select_related("employee", "leave_type").order_by("-year", "employee__code")
    serializer_class = LeaveBalanceSerializer
    filterset_fields = ["employee", "leave_type", "year"]

    @extend_schema(
        request=LeaveBalanceSerializer,
        responses={201: LeaveBalanceSerializer},
        description="Allocate (or re-allocate) a balance; without `allocated` the type's annual quota is used.",
    )
    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.allocate_leave(self.actor, **v), created=True)


class LeaveRequestSerializer(serializers.ModelSerializer):
    employee = employee_field(f"{services.LEAVE}.create")
    employee_code = serializers.CharField(source="employee.code", read_only=True)
    employee_name = serializers.CharField(source="employee.full_name", read_only=True)
    leave_type = OrgScopedPK(queryset=LeaveType.objects.filter(is_active=True), org_path="company__organization_id")

    class Meta:
        model = LeaveRequest
        fields = [
            "id",
            "version",
            "status",
            "employee",
            "employee_code",
            "employee_name",
            "leave_type",
            "from_date",
            "to_date",
            "days",
            "reason",
            "submitted_by",
            "approved_by",
            "created_by",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "version",
            "status",
            "employee_code",
            "employee_name",
            "days",
            "submitted_by",
            "approved_by",
            "created_by",
            "created_at",
        ]


class CancelBody(serializers.Serializer):
    reason = serializers.CharField(required=False, allow_blank=True, default="")
    version = serializers.IntegerField(required=False)


class LeaveRequestViewSet(DocumentViewSet):
    authz_resource = services.LEAVE
    authz_actions = {"submit": "update", "decide": "approve", "cancel": "cancel"}
    queryset = LeaveRequest.objects.select_related("employee", "leave_type").order_by("-from_date")
    serializer_class = LeaveRequestSerializer
    filterset_fields = ["status", "employee", "leave_type"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_leave_request(self.actor, **v), created=True)

    @extend_schema(request=VersionBody, responses=LeaveRequestSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.respond(services.submit_leave_request(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DecisionBody, responses=LeaveRequestSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            services.decide_leave_request(
                self.actor,
                self.get_object(),
                approve=v["approve"],
                comment=v["comment"],
                expected_version=v.get("version"),
            )
        )

    @extend_schema(request=CancelBody, responses=LeaveRequestSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        v = self.validated(CancelBody)
        return self.respond(
            services.cancel_leave_request(
                self.actor, self.get_object(), reason=v["reason"], expected_version=v.get("version")
            )
        )


# --- Salary configuration ------------------------------------------------------------------------------------


class SalaryComponentSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action=f"{services.STRUCTURE}.create")

    class Meta:
        model = SalaryComponent
        fields = [
            "id",
            "version",
            "company",
            "code",
            "name",
            "kind",
            "calculation",
            "is_basic",
            "is_statutory",
            "prorate",
            "rate_pct",
            "wage_ceiling",
            "gross_max",
            "gross_min",
            "expense_key",
            "liability_key",
            "sequence",
            "is_active",
        ]
        read_only_fields = ["id", "version"]
        validators: list = []

    def validate(self, attrs):
        merged = {f: getattr(self.instance, f) for f in self.Meta.fields if self.instance and hasattr(self.instance, f)}
        merged.update(attrs)
        company = merged.get("company")
        services.validate_component(company.pk if company else None, merged)
        return attrs


@master_schema
class SalaryComponentViewSet(MasterDataViewSet):
    authz_resource = services.STRUCTURE
    queryset = SalaryComponent.objects.all()
    serializer_class = SalaryComponentSerializer
    ordering = ["sequence", "code"]
    editable_fields = (
        "name",
        "prorate",
        "rate_pct",
        "wage_ceiling",
        "gross_max",
        "gross_min",
        "expense_key",
        "liability_key",
        "sequence",
        "is_active",
    )
    filterset_fields = ["kind", "is_statutory", "is_active"]


class StructureLineSerializer(serializers.ModelSerializer):
    component = OrgScopedPK(
        queryset=SalaryComponent.objects.filter(is_active=True), org_path="company__organization_id"
    )
    component_code = serializers.CharField(source="component.code", read_only=True)

    class Meta:
        model = SalaryStructureLine
        fields = ["id", "component", "component_code", "amount", "rate_pct"]
        read_only_fields = ["id", "component_code"]


class SalaryStructureSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action=f"{services.STRUCTURE}.create")
    lines = StructureLineSerializer(many=True)

    class Meta:
        model = SalaryStructure
        fields = ["id", "version", "company", "code", "name", "is_active", "lines"]
        read_only_fields = ["id", "version", "is_active"]
        validators: list = []


class SalaryStructureViewSet(DocumentViewSet):
    authz_resource = services.STRUCTURE
    queryset = SalaryStructure.objects.prefetch_related("lines__component").order_by("code")
    serializer_class = SalaryStructureSerializer
    filterset_fields = ["is_active"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_structure(self.actor, **v), created=True)


class SalaryLineSerializer(serializers.ModelSerializer):
    component = OrgScopedPK(queryset=SalaryComponent.objects.all(), org_path="company__organization_id")
    component_code = serializers.CharField(source="component.code", read_only=True)

    class Meta:
        model = EmployeeSalaryLine
        fields = ["component", "component_code", "amount"]
        read_only_fields = ["component_code"]


class EmployeeSalarySerializer(serializers.ModelSerializer):
    """Only reachable with `hr.salary.read` (MFA): the endpoint itself is the sensitive boundary."""

    employee = employee_field(f"{services.SALARY}.create")
    employee_code = serializers.CharField(source="employee.code", read_only=True)
    structure = OrgScopedPK(
        queryset=SalaryStructure.objects.filter(is_active=True), org_path="company__organization_id"
    )
    lines = SalaryLineSerializer(many=True)

    class Meta:
        model = EmployeeSalary
        fields = [
            "id",
            "version",
            "employee",
            "employee_code",
            "structure",
            "effective_from",
            "currency",
            "notes",
            "lines",
        ]
        read_only_fields = ["id", "version", "employee_code", "currency"]
        validators: list = []


class SalaryUpdateSerializer(serializers.Serializer):
    lines = SalaryLineSerializer(many=True)
    notes = serializers.CharField(max_length=300, required=False, allow_blank=True)
    version = serializers.IntegerField()


class EmployeeSalaryViewSet(DocumentViewSet):
    authz_resource = services.SALARY
    queryset = (
        EmployeeSalary.objects.select_related("employee")
        .prefetch_related("lines__component")
        .order_by("employee__code", "-effective_from")
    )
    serializer_class = EmployeeSalarySerializer
    filterset_fields = ["employee", "structure"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.assign_salary(self.actor, **v), created=True)

    @extend_schema(request=SalaryUpdateSerializer, responses=EmployeeSalarySerializer)
    def partial_update(self, request, pk=None):
        salary = self.get_object()
        v = self.validated(SalaryUpdateSerializer)
        return self.respond(
            services.update_salary(
                self.actor, salary, lines=v["lines"], notes=v.get("notes"), expected_version=v["version"]
            )
        )


# --- Payroll ---------------------------------------------------------------------------------------------------

RUN_AMOUNT_FIELDS = ("gross_total", "deduction_total", "employer_total", "net_total", "amount")
PAYSLIP_AMOUNT_FIELDS = ("gross", "total_deductions", "employer_contributions", "net_pay", "lines")


class PayrollRunSerializer(serializers.ModelSerializer):
    """Totals are salary data: omitted unless the caller can read salaries company-wide."""

    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action=f"{services.RUN}.create")

    class Meta:
        model = PayrollRun
        fields = [
            "id",
            "number",
            "version",
            "status",
            "company",
            "year",
            "month",
            "period_start",
            "period_end",
            "employee_count",
            *RUN_AMOUNT_FIELDS,
            "currency",
            "computed_at",
            "submitted_by",
            "approved_by",
            "posted_by",
            "posted_at",
            "posting_date",
            "journal_entry",
            "created_by",
            "created_at",
        ]
        read_only_fields = [f for f in fields if f not in ("company", "year", "month")]
        validators: list = []

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get("request")
        if request is None or not services.can_read_salary(actor_for(request), company_id=instance.company_id):
            for name in RUN_AMOUNT_FIELDS:
                data.pop(name, None)
        return data


class PostRunSerializer(serializers.Serializer):
    posting_date = serializers.DateField(required=False)
    version = serializers.IntegerField(required=False)


class ReasonVersionBody(serializers.Serializer):
    reason = serializers.CharField(max_length=300)
    version = serializers.IntegerField(required=False)


class PayrollRunViewSet(DocumentViewSet):
    authz_resource = services.RUN
    authz_actions = {
        "compute": "update",
        "submit": "update",
        "decide": "approve",
        "post_run": "post",
        "reverse": "reverse",
    }
    queryset = PayrollRun.objects.order_by("-year", "-month")
    serializer_class = PayrollRunSerializer
    filterset_fields = ["status", "year"]

    def create(self, request):
        v = dict(self.validated())
        return self.respond(services.create_payroll_run(self.actor, **v), created=True)

    @extend_schema(request=VersionBody, responses=PayrollRunSerializer)
    @action(detail=True, methods=["post"])
    def compute(self, request, pk=None):
        return self.respond(services.compute_payroll(self.actor, self.get_object(), self.version()))

    @extend_schema(request=VersionBody, responses=PayrollRunSerializer)
    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return self.respond(services.submit_payroll(self.actor, self.get_object(), self.version()))

    @extend_schema(request=DecisionBody, responses=PayrollRunSerializer)
    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        v = self.validated(DecisionBody)
        return self.respond(
            services.decide_payroll(
                self.actor,
                self.get_object(),
                approve=v["approve"],
                comment=v["comment"],
                expected_version=v.get("version"),
            )
        )

    @extend_schema(request=ReasonVersionBody, responses=PayrollRunSerializer, parameters=[idempotency_header(False)])
    @action(detail=True, methods=["post"])
    @idempotent()
    def reverse(self, request, pk=None):
        v = self.validated(ReasonVersionBody)
        return self.respond(
            services.reverse_payroll(
                self.actor, self.get_object(), reason=v["reason"], expected_version=v.get("version")
            )
        )

    @extend_schema(request=PostRunSerializer, responses=PayrollRunSerializer, parameters=[IDEM])
    @action(detail=True, methods=["post"], url_path="post")
    @idempotent(required=True)
    def post_run(self, request, pk=None):
        v = self.validated(PostRunSerializer)
        return self.respond(
            services.post_payroll(
                self.actor,
                self.get_object(),
                posting_date=v.get("posting_date"),
                expected_version=v.get("version"),
            )
        )


class PayslipLineSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayslipLine
        fields = ["code", "name", "kind", "is_statutory", "base_amount", "rate_pct", "amount"]
        read_only_fields = fields


class PayslipSerializer(serializers.ModelSerializer):
    """Amounts (and lines) are omitted unless the caller holds `hr.salary.read` or it's their own payslip."""

    employee_code = serializers.CharField(source="employee.code", read_only=True)
    employee_name = serializers.CharField(source="employee.full_name", read_only=True)
    period = serializers.SerializerMethodField()
    status = serializers.CharField(source="run.status", read_only=True)
    lines = PayslipLineSerializer(many=True, read_only=True)

    class Meta:
        model = Payslip
        fields = [
            "id",
            "run",
            "period",
            "status",
            "employee",
            "employee_code",
            "employee_name",
            "department",
            "cost_center",
            "days_in_period",
            "present_days",
            "paid_leave_days",
            "holiday_days",
            "paid_days",
            "lop_days",
            *PAYSLIP_AMOUNT_FIELDS,
        ]
        read_only_fields = fields

    def get_period(self, obj) -> str:
        return f"{obj.run.year}-{obj.run.month:02d}"

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get("request")
        visible = request is not None and services.can_read_salary(
            actor_for(request),
            company_id=instance.company_id,
            department_id=instance.department_id,
            employee_id=instance.employee_id,
        )
        if not visible:
            for name in PAYSLIP_AMOUNT_FIELDS:
                data.pop(name, None)
        return data


class PayslipViewSet(ERPReadOnlyViewSet):
    authz_resource = services.PAYSLIP
    queryset = (
        Payslip.objects.select_related("run", "employee")
        .prefetch_related("lines")
        .order_by("-run__year", "-run__month", "employee__code")
    )
    serializer_class = PayslipSerializer
    filterset_fields = ["run", "employee", "department"]

    def get_queryset(self):
        return super().get_queryset().filter(services.own_payslips_q(self.request.user))


# --- Self-service ----------------------------------------------------------------------------------------------


def _own_employee(request) -> Employee:
    ctx = actor_for(request)
    require_module(ctx, "hr")
    employee = services.employee_for_user(request.user, ctx.company_id) or services.employee_for_user(request.user)
    if employee is None:
        raise NotFound("No employee record is linked to your account.")
    return employee


class MyProfileView(APIView):
    """The caller's own employee record (masked sensitive fields)."""

    authz_authenticated_only = True

    @extend_schema(responses=EmployeeSerializer, tags=["hr"])
    def get(self, request):
        return Response(EmployeeSerializer(_own_employee(request)).data)


class MyPayslipsView(APIView):
    """The caller's own posted payslips, with amounts."""

    authz_authenticated_only = True

    @extend_schema(responses=PayslipSerializer(many=True), tags=["hr"])
    def get(self, request):
        employee = _own_employee(request)
        qs = (
            Payslip.objects.filter(employee=employee, run__status="posted")
            .select_related("run", "employee")
            .prefetch_related("lines")
            .order_by("-run__year", "-run__month")
        )
        return Response(PayslipSerializer(qs, many=True, context={"request": request}).data)


class MyLeaveSerializer(serializers.Serializer):
    leave_type = OrgScopedPK(queryset=LeaveType.objects.filter(is_active=True), org_path="company__organization_id")
    from_date = serializers.DateField()
    to_date = serializers.DateField()
    reason = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    submit = serializers.BooleanField(default=True)


class MyLeaveRequestsView(APIView):
    """The caller's own leave requests and balances; POST files (and by default submits) a request."""

    authz_authenticated_only = True

    @extend_schema(responses=LeaveRequestSerializer(many=True), tags=["hr"])
    def get(self, request):
        employee = _own_employee(request)
        qs = LeaveRequest.objects.filter(employee=employee).select_related("employee").order_by("-from_date")
        return Response(LeaveRequestSerializer(qs, many=True, context={"request": request}).data)

    @extend_schema(request=MyLeaveSerializer, responses={201: LeaveRequestSerializer}, tags=["hr"])
    def post(self, request):
        employee = _own_employee(request)
        data = MyLeaveSerializer(data=request.data, context={"request": request})
        data.is_valid(raise_exception=True)
        v = dict(data.validated_data)
        submit = v.pop("submit")
        ctx = actor_for(request)
        with transaction.atomic():
            leave = services.create_leave_request(ctx, employee=employee, **v)
            if submit:
                leave = services.submit_leave_request(ctx, leave)
        fresh = LeaveRequest.objects.select_related("employee").get(pk=leave.pk)
        return Response(
            LeaveRequestSerializer(fresh, context={"request": request}).data, status=status.HTTP_201_CREATED
        )


class MyLeaveBalancesView(APIView):
    authz_authenticated_only = True

    @extend_schema(responses=LeaveBalanceSerializer(many=True), tags=["hr"])
    def get(self, request):
        employee = _own_employee(request)
        qs = LeaveBalance.objects.filter(employee=employee).select_related("employee", "leave_type").order_by("-year")
        return Response(LeaveBalanceSerializer(qs, many=True, context={"request": request}).data)


router = SimpleRouter()
router.register("hr/employees", EmployeeViewSet, basename="hr-employee")
router.register("hr/attendance", AttendanceViewSet, basename="hr-attendance")
router.register("hr/leave-types", LeaveTypeViewSet, basename="hr-leave-type")
router.register("hr/leave-balances", LeaveBalanceViewSet, basename="hr-leave-balance")
router.register("hr/leave-requests", LeaveRequestViewSet, basename="hr-leave-request")
router.register("hr/salary-components", SalaryComponentViewSet, basename="hr-salary-component")
router.register("hr/salary-structures", SalaryStructureViewSet, basename="hr-salary-structure")
router.register("hr/salaries", EmployeeSalaryViewSet, basename="hr-salary")
router.register("hr/payroll-runs", PayrollRunViewSet, basename="hr-payroll-run")
router.register("hr/payslips", PayslipViewSet, basename="hr-payslip")

urlpatterns = [
    path("hr/my/profile/", MyProfileView.as_view(), name="hr-my-profile"),
    path("hr/my/payslips/", MyPayslipsView.as_view(), name="hr-my-payslips"),
    path("hr/my/leave-requests/", MyLeaveRequestsView.as_view(), name="hr-my-leave-requests"),
    path("hr/my/leave-balances/", MyLeaveBalancesView.as_view(), name="hr-my-leave-balances"),
    *router.urls,
]
