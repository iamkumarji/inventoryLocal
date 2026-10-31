from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization import pdp
from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet
from apps.organization import services
from apps.organization.models import Branch, Company, Department, Facility, FiscalYear, Warehouse

from . import serializers as s


class _NodeViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    """List/retrieve/create/partial-update for organization nodes. No deletes: deactivate instead."""

    create_serializer_class: type
    update_serializer_class: type
    filterset_fields = ["is_active"]
    search_fields = ["code", "name"]
    ordering_fields = ["code", "name", "created_at"]
    ordering = ["code"]

    def create_node(self, data: dict):
        raise NotImplementedError

    def create(self, request):
        data = self.create_serializer_class(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        instance = self.create_node(dict(data.validated_data))
        return Response(self.get_serializer(instance).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        instance = self.get_object()
        data = self.update_serializer_class(data=request.data, partial=True, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        version = request.data.get("version")
        try:
            version = int(version) if version is not None else None
        except (TypeError, ValueError):
            version = None
        instance = services.update_node(self.actor, instance, dict(data.validated_data), version)
        return Response(self.get_serializer(instance).data)


def _node_schema(viewset, create_cls, update_cls, read_cls):
    """Attach per-viewset OpenAPI docs. Each subclass gets its own method objects: decorating the
    inherited functions directly would make every subclass share the last schema applied."""

    def create(self, request):
        return _NodeViewSet.create(self, request)

    def partial_update(self, request, pk=None):
        return _NodeViewSet.partial_update(self, request, pk)

    viewset.create = extend_schema(request=create_cls, responses={201: read_cls})(create)
    viewset.partial_update = extend_schema(
        request=update_cls,
        responses=read_cls,
        description="Partial update. Include `version` (optimistic lock) in the body.",
    )(partial_update)
    return viewset


class CompanyViewSet(_NodeViewSet):
    authz_resource = "organization.company"
    queryset = Company.objects.all()
    serializer_class = s.CompanySerializer
    create_serializer_class = s.CompanyCreateSerializer
    update_serializer_class = s.update_serializer_for(Company)
    search_fields = ["code", "legal_name", "trade_name", "gstin"]
    ordering_fields = ["code", "legal_name", "created_at"]

    def create_node(self, data):
        return services.create_company(self.actor, organization=self.request.user.organization, **data)


class BranchViewSet(_NodeViewSet):
    authz_resource = "organization.branch"
    queryset = Branch.objects.all()
    serializer_class = s.BranchSerializer
    create_serializer_class = s.BranchCreateSerializer
    update_serializer_class = s.update_serializer_for(Branch)
    filterset_fields = ["is_active", "company"]

    def create_node(self, data):
        return services.create_branch(self.actor, company=data.pop("company"), **data)


class DepartmentViewSet(_NodeViewSet):
    authz_resource = "organization.department"
    queryset = Department.objects.all()
    serializer_class = s.DepartmentSerializer
    create_serializer_class = s.DepartmentCreateSerializer
    update_serializer_class = s.update_serializer_for(Department)
    filterset_fields = ["is_active", "company", "parent"]

    def create_node(self, data):
        return services.create_department(
            self.actor, company=data.pop("company"), parent=data.pop("parent", None), **data
        )


class FacilityViewSet(_NodeViewSet):
    authz_resource = "organization.facility"
    queryset = Facility.objects.all()
    serializer_class = s.FacilitySerializer
    create_serializer_class = s.FacilityCreateSerializer
    update_serializer_class = s.update_serializer_for(Facility)
    filterset_fields = ["is_active", "company", "branch", "facility_type"]

    def create_node(self, data):
        return services.create_facility(self.actor, branch=data.pop("branch"), **data)


class WarehouseViewSet(_NodeViewSet):
    authz_resource = "organization.warehouse"
    queryset = Warehouse.objects.all()
    serializer_class = s.WarehouseSerializer
    create_serializer_class = s.WarehouseCreateSerializer
    update_serializer_class = s.update_serializer_for(Warehouse)
    filterset_fields = ["is_active", "company", "branch", "facility", "warehouse_type"]

    def create_node(self, data):
        return services.create_warehouse(
            self.actor, branch=data.pop("branch"), facility=data.pop("facility", None), **data
        )


for _vs, _read in (
    (CompanyViewSet, s.CompanySerializer),
    (BranchViewSet, s.BranchSerializer),
    (DepartmentViewSet, s.DepartmentSerializer),
    (FacilityViewSet, s.FacilitySerializer),
    (WarehouseViewSet, s.WarehouseSerializer),
):
    _node_schema(_vs, _vs.create_serializer_class, _vs.update_serializer_class, _read)


class FiscalYearViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    authz_resource = "organization.fiscal_year"
    queryset = FiscalYear.objects.prefetch_related("periods").order_by("-start_date")
    serializer_class = s.FiscalYearSerializer
    filterset_fields = ["company", "status"]

    @extend_schema(request=s.FiscalYearCreateSerializer, responses={201: s.FiscalYearSerializer})
    def create(self, request):
        data = s.FiscalYearCreateSerializer(data=request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        fy = services.create_fiscal_year(
            self.actor, company=data.validated_data["company"], start_year=data.validated_data["start_year"]
        )
        return Response(self.get_serializer(fy).data, status=status.HTTP_201_CREATED)

    @extend_schema(responses=s.FiscalPeriodSerializer(many=True))
    @action(detail=True, methods=["get"])
    def periods(self, request, pk=None):
        return Response(s.FiscalPeriodSerializer(self.get_object().periods.all(), many=True).data)


class ScopeTreeView(APIView):
    """The organization tree limited to what the caller can read (for scope pickers and navigation)."""

    authz_authenticated_only = True

    @extend_schema(
        responses=inline_serializer("ScopeTree", {"companies": serializers.ListField()}), tags=["organization"]
    )
    def get(self, request):
        ctx = actor_for(request)
        visible = {
            model: set(
                pdp.filter_queryset(
                    ctx, f"{model.authz_resource_type}.read", model.objects.filter(is_active=True)
                ).values_list("id", flat=True)
            )
            for model in (Branch, Facility, Warehouse, Department)
        }
        companies = Company.objects.filter(pk__in=pdp.accessible_company_ids(ctx.user.pk), is_active=True)
        tree = []
        for company in companies.order_by("code"):
            branches = []
            for branch in company.branches.filter(is_active=True).order_by("code"):
                warehouses = [
                    {"id": str(w.pk), "code": w.code, "name": w.name, "type": w.warehouse_type}
                    for w in branch.warehouses.filter(is_active=True).order_by("code")
                    if w.pk in visible[Warehouse]
                ]
                facilities = [
                    {"id": str(f.pk), "code": f.code, "name": f.name, "type": f.facility_type}
                    for f in branch.facilities.filter(is_active=True).order_by("code")
                    if f.pk in visible[Facility]
                ]
                if branch.pk in visible[Branch] or warehouses or facilities:
                    branches.append(
                        {
                            "id": str(branch.pk),
                            "code": branch.code,
                            "name": branch.name,
                            "facilities": facilities,
                            "warehouses": warehouses,
                        }
                    )
            departments = [
                {
                    "id": str(d.pk),
                    "code": d.code,
                    "name": d.name,
                    "parent_id": str(d.parent_id) if d.parent_id else None,
                }
                for d in company.departments.filter(is_active=True).order_by("code")
                if d.pk in visible[Department]
            ]
            tree.append(
                {
                    "id": str(company.pk),
                    "code": company.code,
                    "name": company.trade_name or company.legal_name,
                    "branches": branches,
                    "departments": departments,
                }
            )
        return Response({"companies": tree})
