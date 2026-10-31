from rest_framework import serializers

from apps.authorization import pdp
from apps.authorization.context import actor_for
from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.inventory.models import (
    Batch,
    ItemValuation,
    Location,
    SerialNumber,
    StockAdjustment,
    StockAdjustmentLine,
    StockCount,
    StockCountLine,
    StockLedgerEntry,
    StockTransfer,
    StockTransferLine,
)
from apps.masterdata.models import Item
from apps.organization.models import Company, Warehouse

DOC_META = ["id", "number", "status", "version", "created_by", "created_at", "updated_at"]


class ItemPK(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get("request")
        return (
            Item.objects.none()
            if request is None
            else Item.objects.filter(organization_id=request.user.organization_id, is_active=True)
        )


def wh_field(action):
    return ScopedPrimaryKeyRelatedField(queryset=Warehouse.objects.filter(is_active=True), read_action=action)


class LocationSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="inventory.location.read")
    warehouse = wh_field("inventory.location.read")

    class Meta:
        model = Location
        fields = ["id", "version", "company", "warehouse", "parent", "code", "name", "kind", "is_active"]
        read_only_fields = ["id", "version"]
        validators: list = []


class StockSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source="item.code", read_only=True)
    item_name = serializers.CharField(source="item.name", read_only=True)
    uom = serializers.CharField(source="item.stock_uom.code", read_only=True)
    warehouse_code = serializers.CharField(source="warehouse.code", read_only=True)

    class Meta:
        model = ItemValuation
        fields = [
            "id",
            "item",
            "item_code",
            "item_name",
            "uom",
            "warehouse",
            "warehouse_code",
            "quantity",
            "reserved_quantity",
            "avg_cost",
            "value",
            "updated_at",
        ]
        read_only_fields = fields


class LedgerSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source="item.code", read_only=True)
    warehouse_code = serializers.CharField(source="warehouse.code", read_only=True)
    batch_number = serializers.CharField(source="batch.batch_number", read_only=True, default=None)

    class Meta:
        model = StockLedgerEntry
        fields = [
            "id",
            "posting_date",
            "item",
            "item_code",
            "warehouse",
            "warehouse_code",
            "location",
            "batch",
            "batch_number",
            "movement_type",
            "stock_status",
            "quantity",
            "unit_cost",
            "value",
            "balance_quantity_after",
            "balance_value_after",
            "source_type",
            "source_id",
            "created_at",
        ]
        read_only_fields = fields


class BatchSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = Batch
        fields = ["id", "item", "item_code", "batch_number", "manufactured_on", "expires_on", "supplier_batch"]
        read_only_fields = fields


class SerialSerializer(serializers.ModelSerializer):
    class Meta:
        model = SerialNumber
        fields = ["id", "item", "serial", "batch", "status", "warehouse", "location", "stock_status"]
        read_only_fields = fields


class AdjustmentLineSerializer(serializers.ModelSerializer):
    item = ItemPK()
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = StockAdjustmentLine
        fields = [
            "id",
            "item",
            "item_code",
            "location",
            "batch_number",
            "expires_on",
            "serials",
            "quantity",
            "unit_cost",
        ]
        read_only_fields = ["id", "item_code"]


class AdjustmentSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(
        queryset=Company.objects.all(), read_action="inventory.stock_adjustment.read"
    )
    warehouse = wh_field("inventory.stock_adjustment.read")
    lines = AdjustmentLineSerializer(many=True)

    class Meta:
        model = StockAdjustment
        fields = [
            *DOC_META,
            "company",
            "warehouse",
            "posting_date",
            "reason",
            "notes",
            "amount",
            "currency",
            "submitted_by",
            "approved_by",
            "stock_transaction",
            "lines",
        ]
        read_only_fields = [*DOC_META, "amount", "currency", "submitted_by", "approved_by", "stock_transaction"]


class TransferLineSerializer(serializers.ModelSerializer):
    item = ItemPK()
    item_code = serializers.CharField(source="item.code", read_only=True)

    class Meta:
        model = StockTransferLine
        fields = ["id", "item", "item_code", "batch", "serials", "quantity", "from_location", "to_location"]
        read_only_fields = ["id", "item_code"]


class TransferSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="inventory.stock_transfer.read")
    from_warehouse = wh_field("inventory.stock_transfer.read")
    to_warehouse = serializers.PrimaryKeyRelatedField(queryset=Warehouse.objects.filter(is_active=True))
    lines = TransferLineSerializer(many=True)

    class Meta:
        model = StockTransfer
        fields = [
            *DOC_META,
            "company",
            "from_warehouse",
            "to_warehouse",
            "dispatched_on",
            "received_on",
            "notes",
            "dispatched_by",
            "received_by",
            "lines",
        ]
        read_only_fields = [*DOC_META, "dispatched_on", "received_on", "dispatched_by", "received_by"]


class CountLineSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source="item.code", read_only=True)
    item_name = serializers.CharField(source="item.name", read_only=True)
    # Counters need to know which batch and bin a line is for (the same item can have several lines).
    batch_number = serializers.CharField(source="batch.batch_number", default=None, read_only=True)
    location_code = serializers.CharField(source="location.code", default=None, read_only=True)

    class Meta:
        model = StockCountLine
        fields = [
            "id",
            "item",
            "item_code",
            "item_name",
            "location",
            "location_code",
            "batch",
            "batch_number",
            "system_quantity",
            "counted_quantity",
            "counted_by",
        ]
        read_only_fields = fields

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if self.context.get("hide_system"):
            data["system_quantity"] = None  # blind count
        return data


class CountSerializer(serializers.ModelSerializer):
    lines = serializers.SerializerMethodField()

    class Meta:
        model = StockCount
        fields = [*DOC_META, "company", "warehouse", "count_date", "blind", "approved_by", "stock_transaction", "lines"]
        read_only_fields = fields

    def get_lines(self, obj) -> list:
        # Blind counts hide the system quantity from everyone who can't approve this count, on list
        # and detail responses alike, until it is posted.
        context = dict(self.context)
        request = context.get("request")
        if obj.blind and obj.status != StockCount.Status.POSTED:
            actor = actor_for(request) if request is not None else None
            context["hide_system"] = actor is None or not pdp.can(
                actor, "inventory.stock_count.approve", pdp.Resource.of(obj)
            )
        else:
            context["hide_system"] = False
        return CountLineSerializer(
            obj.lines.select_related("item", "batch", "location"), many=True, context=context
        ).data


class CountStartSerializer(serializers.Serializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="inventory.stock_count.read")
    warehouse = wh_field("inventory.stock_count.read")
    count_date = serializers.DateField()
    blind = serializers.BooleanField(default=True)
    item_ids = serializers.ListField(child=serializers.UUIDField(), required=False)


class CountEntrySerializer(serializers.Serializer):
    line_id = serializers.UUIDField(required=False)
    item_id = serializers.UUIDField(required=False)
    location_id = serializers.UUIDField(required=False, allow_null=True)
    batch_number = serializers.CharField(required=False, allow_blank=True)
    counted_quantity = serializers.DecimalField(max_digits=20, decimal_places=6)

    def validate(self, attrs):
        if not attrs.get("line_id") and not attrs.get("item_id"):
            raise serializers.ValidationError("Give the count line, or the item for stock not on the list.")
        return attrs


class DateSerializer(serializers.Serializer):
    on = serializers.DateField()
    version = serializers.IntegerField(required=False)


class DocVersionSerializer(serializers.Serializer):
    version = serializers.IntegerField(required=False)
