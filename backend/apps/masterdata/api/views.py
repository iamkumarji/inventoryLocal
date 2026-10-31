from django.db.models import Q
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.authorization import pdp
from apps.core.exceptions import BusinessRuleViolation, NotFound
from apps.masterdata.models import HsnCode, Item, ItemBarcode, ItemCategory, ItemWarehousePolicy, Uom, UomConversion
from apps.shared.crud import create_record
from apps.shared.viewsets import MasterDataViewSet, master_schema

from . import serializers as s


@master_schema
class UomViewSet(MasterDataViewSet):
    authz_resource = "masterdata.uom"
    queryset = Uom.objects.all()
    serializer_class = s.UomSerializer
    editable_fields = ("name", "decimals", "is_active")
    pagination_class = None


@master_schema
class UomConversionViewSet(MasterDataViewSet):
    authz_resource = "masterdata.uom"
    queryset = UomConversion.objects.select_related("from_uom", "to_uom")
    serializer_class = s.UomConversionSerializer
    editable_fields = ("factor",)
    filterset_fields = ["item"]
    ordering = ["from_uom__code"]


@master_schema
class ItemCategoryViewSet(MasterDataViewSet):
    authz_resource = "masterdata.item_category"
    queryset = ItemCategory.objects.all()
    serializer_class = s.ItemCategorySerializer
    editable_fields = ("name", "parent", "posting_group", "is_active")
    pagination_class = None


@master_schema
class HsnCodeViewSet(MasterDataViewSet):
    authz_resource = "masterdata.hsn_code"
    queryset = HsnCode.objects.all()
    serializer_class = s.HsnCodeSerializer
    editable_fields = ("description", "gst_rate", "is_service", "is_active")
    search_fields = ["code", "description"]


LOCKED_AFTER_STOCK = {"stock_uom", "tracking"}


@master_schema
class ItemViewSet(MasterDataViewSet):
    authz_resource = "masterdata.item"
    authz_actions = {"add_barcode": "update", "lookup": "read"}
    queryset = Item.objects.select_related("category", "stock_uom").prefetch_related("barcodes")
    serializer_class = s.ItemSerializer
    editable_fields = (
        "name",
        "description",
        "item_type",
        "category",
        "stock_uom",
        "purchase_uom",
        "sales_uom",
        "tracking",
        "shelf_life_days",
        "hsn",
        "is_stocked",
        "is_purchasable",
        "is_saleable",
        "is_manufactured",
        "inspection_required",
        "standard_cost",
        "is_active",
    )
    filterset_fields = [
        "item_type",
        "category",
        "tracking",
        "is_active",
        "is_purchasable",
        "is_saleable",
        "is_manufactured",
    ]
    search_fields = ["code", "name", "barcodes__barcode"]
    ordering_fields = ["code", "name"]

    def partial_update(self, request, *args, **kwargs):
        item = self.get_object()
        touched = LOCKED_AFTER_STOCK & set(request.data)
        changed = {f for f in touched if str(request.data[f]) != str(getattr(item, f"{f}_id", getattr(item, f)))}
        if changed:
            from apps.inventory.selectors import item_has_history  # inventory sits above master data

            if item_has_history(item):
                raise BusinessRuleViolation(
                    "Stock unit and tracking can't change once the item has stock history.", code="item_locked_by_stock"
                )
        return super().partial_update(request, *args, **kwargs)

    @extend_schema(request=s.BarcodeSerializer, responses={201: s.ItemSerializer})
    @action(detail=True, methods=["post"], url_path="barcodes")
    def add_barcode(self, request, pk=None):
        item = self.get_object()
        data = s.BarcodeSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        create_record(
            self.actor,
            ItemBarcode,
            {**data.validated_data, "item": item, "organization_id": item.organization_id},
            resource=pdp.Resource.of(item),
        )
        return Response(s.ItemSerializer(self.get_queryset().get(pk=item.pk)).data, status=status.HTTP_201_CREATED)

    @extend_schema(parameters=[OpenApiParameter("code", str, required=True)], responses=s.ItemSerializer)
    @action(detail=False, methods=["get"])
    def lookup(self, request):
        """Resolve a scanned barcode or an item code."""
        code = request.query_params.get("code", "").strip()
        item = self.get_queryset().filter(Q(code=code) | Q(barcodes__barcode=code)).first()
        if item is None:
            raise NotFound("No item with that barcode or code.")
        return Response(s.ItemSerializer(item).data)


@master_schema
class ItemWarehousePolicyViewSet(MasterDataViewSet):
    authz_resource = "masterdata.item_policy"
    queryset = ItemWarehousePolicy.objects.all()
    serializer_class = s.ItemWarehousePolicySerializer
    editable_fields = ("reorder_level", "reorder_quantity", "min_quantity", "max_quantity", "lead_time_days")
    filterset_fields = ["item", "warehouse", "company"]
    ordering = ["item__code"]

    def create_resource(self, validated):
        return pdp.Resource.ref(
            "masterdata.item_policy", company_id=validated["company"].pk, warehouse_id=validated["warehouse"].pk
        )
