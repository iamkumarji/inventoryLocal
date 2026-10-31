from rest_framework import serializers

from apps.masterdata.models import HsnCode, Item, ItemBarcode, ItemCategory, ItemWarehousePolicy, Uom, UomConversion

META = ["id", "version", "created_at", "updated_at"]


class OrgScopedPK(serializers.PrimaryKeyRelatedField):
    """FK limited to the caller's organization (shared master data)."""

    def get_queryset(self):
        request = self.context.get("request")
        qs = super().get_queryset()
        return qs.none() if request is None else qs.filter(organization_id=request.user.organization_id)


class UomSerializer(serializers.ModelSerializer):
    class Meta:
        model = Uom
        fields = ["id", "code", "name", "kind", "decimals", "is_active"]


class UomConversionSerializer(serializers.ModelSerializer):
    item = OrgScopedPK(queryset=Item.objects.all(), required=False, allow_null=True)
    from_uom = OrgScopedPK(queryset=Uom.objects.all())
    to_uom = OrgScopedPK(queryset=Uom.objects.all())

    class Meta:
        model = UomConversion
        fields = ["id", "item", "from_uom", "to_uom", "factor"]
        validators: list = []


class ItemCategorySerializer(serializers.ModelSerializer):
    parent = OrgScopedPK(queryset=ItemCategory.objects.all(), required=False, allow_null=True)

    class Meta:
        model = ItemCategory
        fields = [*META, "code", "name", "parent", "posting_group", "is_active"]
        read_only_fields = META


class HsnCodeSerializer(serializers.ModelSerializer):
    class Meta:
        model = HsnCode
        fields = ["id", "code", "description", "gst_rate", "is_service", "is_active"]


class BarcodeSerializer(serializers.ModelSerializer):
    class Meta:
        model = ItemBarcode
        fields = ["id", "barcode", "symbology", "uom"]


class ItemSerializer(serializers.ModelSerializer):
    category = OrgScopedPK(queryset=ItemCategory.objects.filter(is_active=True))
    stock_uom = OrgScopedPK(queryset=Uom.objects.filter(is_active=True))
    purchase_uom = OrgScopedPK(queryset=Uom.objects.filter(is_active=True), required=False, allow_null=True)
    sales_uom = OrgScopedPK(queryset=Uom.objects.filter(is_active=True), required=False, allow_null=True)
    hsn = OrgScopedPK(queryset=HsnCode.objects.filter(is_active=True), required=False, allow_null=True)
    stock_uom_code = serializers.CharField(source="stock_uom.code", read_only=True)
    category_name = serializers.CharField(source="category.name", read_only=True)
    barcodes = BarcodeSerializer(many=True, read_only=True)

    class Meta:
        model = Item
        fields = [
            *META,
            "code",
            "name",
            "description",
            "item_type",
            "category",
            "category_name",
            "stock_uom",
            "stock_uom_code",
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
            "barcodes",
        ]
        read_only_fields = META


class ItemWarehousePolicySerializer(serializers.ModelSerializer):
    class Meta:
        model = ItemWarehousePolicy
        fields = [
            *META,
            "company",
            "item",
            "warehouse",
            "reorder_level",
            "reorder_quantity",
            "min_quantity",
            "max_quantity",
            "lead_time_days",
        ]
        read_only_fields = META
        validators: list = []
