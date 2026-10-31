from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.identity.models import User
from apps.organization.models import Branch, Company, Department, Facility, FiscalPeriod, FiscalYear, Warehouse

AUDIT_READ_ONLY = ["id", "version", "created_at", "updated_at"]


class CompanySerializer(serializers.ModelSerializer):
    class Meta:
        model = Company
        fields = [
            "id",
            "organization",
            "code",
            "legal_name",
            "trade_name",
            "gstin",
            "pan",
            "cin",
            "state_code",
            "base_currency",
            "fiscal_year_start_month",
            "timezone",
            "address",
            "is_active",
            *AUDIT_READ_ONLY[1:],
        ]
        read_only_fields = ["organization", "base_currency", "fiscal_year_start_month", *AUDIT_READ_ONLY]


class CompanyCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Company
        fields = [
            "code",
            "legal_name",
            "trade_name",
            "gstin",
            "pan",
            "cin",
            "state_code",
            "base_currency",
            "fiscal_year_start_month",
            "timezone",
            "address",
        ]


class BranchSerializer(serializers.ModelSerializer):
    class Meta:
        model = Branch
        fields = ["id", "company", "code", "name", "gstin", "state_code", "address", "is_active", *AUDIT_READ_ONLY[1:]]
        read_only_fields = ["company", *AUDIT_READ_ONLY]


class BranchCreateSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.filter(is_active=True))

    class Meta:
        model = Branch
        fields = ["company", "code", "name", "gstin", "state_code", "address"]


@extend_schema_field(OpenApiTypes.UUID)
class _OrgUserField(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get("request")
        if request is None:
            return User.objects.none()
        return User.objects.filter(organization_id=request.user.organization_id, is_active=True)


class DepartmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Department
        fields = ["id", "company", "parent", "code", "name", "head_user", "is_active", *AUDIT_READ_ONLY[1:]]
        read_only_fields = ["company", *AUDIT_READ_ONLY]


class DepartmentCreateSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.filter(is_active=True))
    parent = ScopedPrimaryKeyRelatedField(queryset=Department.objects.all(), required=False, allow_null=True)
    head_user = _OrgUserField(required=False, allow_null=True)

    class Meta:
        model = Department
        fields = ["company", "parent", "code", "name", "head_user"]


class DepartmentUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False)
    parent = ScopedPrimaryKeyRelatedField(queryset=Department.objects.all(), required=False, allow_null=True)
    head_user = _OrgUserField(required=False, allow_null=True)
    is_active = serializers.BooleanField(required=False)


class FacilitySerializer(serializers.ModelSerializer):
    class Meta:
        model = Facility
        fields = [
            "id",
            "company",
            "branch",
            "code",
            "name",
            "facility_type",
            "address",
            "is_active",
            *AUDIT_READ_ONLY[1:],
        ]
        read_only_fields = ["company", "branch", *AUDIT_READ_ONLY]


class FacilityCreateSerializer(serializers.ModelSerializer):
    branch = ScopedPrimaryKeyRelatedField(queryset=Branch.objects.filter(is_active=True))

    class Meta:
        model = Facility
        fields = ["branch", "code", "name", "facility_type", "address"]


class WarehouseSerializer(serializers.ModelSerializer):
    class Meta:
        model = Warehouse
        fields = [
            "id",
            "company",
            "branch",
            "facility",
            "code",
            "name",
            "warehouse_type",
            "allow_negative_stock",
            "is_active",
            *AUDIT_READ_ONLY[1:],
        ]
        read_only_fields = ["company", "branch", *AUDIT_READ_ONLY]


class WarehouseCreateSerializer(serializers.ModelSerializer):
    branch = ScopedPrimaryKeyRelatedField(queryset=Branch.objects.filter(is_active=True))
    facility = ScopedPrimaryKeyRelatedField(
        queryset=Facility.objects.filter(is_active=True), required=False, allow_null=True
    )

    class Meta:
        model = Warehouse
        fields = ["branch", "facility", "code", "name", "warehouse_type", "allow_negative_stock"]


class WarehouseUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False)
    warehouse_type = serializers.ChoiceField(choices=Warehouse.WarehouseType.choices, required=False)
    facility = ScopedPrimaryKeyRelatedField(
        queryset=Facility.objects.filter(is_active=True), required=False, allow_null=True
    )
    allow_negative_stock = serializers.BooleanField(required=False)
    is_active = serializers.BooleanField(required=False)


class FiscalPeriodSerializer(serializers.ModelSerializer):
    class Meta:
        model = FiscalPeriod
        fields = [
            "id",
            "period_no",
            "start_date",
            "end_date",
            "status",
            "inventory_locked",
            "ap_locked",
            "ar_locked",
            "gl_locked",
        ]
        read_only_fields = fields


class FiscalYearSerializer(serializers.ModelSerializer):
    periods = FiscalPeriodSerializer(many=True, read_only=True)

    class Meta:
        model = FiscalYear
        fields = ["id", "company", "code", "start_date", "end_date", "status", "periods", "created_at"]
        read_only_fields = fields


class FiscalYearCreateSerializer(serializers.Serializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.filter(is_active=True))
    start_year = serializers.IntegerField(min_value=2000, max_value=2100)


def update_serializer_for(model):
    """Partial-update serializers: only editable fields, plus the required optimistic-lock version."""
    from apps.organization.services import EDITABLE_FIELDS

    custom = {Department: DepartmentUpdateSerializer, Warehouse: WarehouseUpdateSerializer}
    if model in custom:
        return custom[model]

    class _Update(serializers.ModelSerializer):
        class Meta:
            fields = list(EDITABLE_FIELDS[model])
            extra_kwargs = {f: {"required": False} for f in EDITABLE_FIELDS[model]}

    _Update.Meta.model = model
    _Update.__name__ = f"{model.__name__}UpdateSerializer"
    return _Update
