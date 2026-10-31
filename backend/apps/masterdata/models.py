from django.db import models
from django.db.models import F, Q

from apps.core.fields import PercentField, QuantityField, RateField
from apps.core.models import ActorStampedModel, AuthzResourceMixin, SharedMasterMixin, VersionedModel


class Uom(SharedMasterMixin, ActorStampedModel):
    class Kind(models.TextChoices):
        COUNT = "count"
        MASS = "mass"
        LENGTH = "length"
        VOLUME = "volume"
        AREA = "area"
        TIME = "time"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    code = models.CharField(max_length=20)
    name = models.CharField(max_length=80)
    kind = models.CharField(max_length=10, choices=Kind.choices)
    decimals = models.PositiveSmallIntegerField(default=3)  # 0 = whole units only (pieces)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "masterdata.uom"

    class Meta:
        db_table = "uoms"
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uq_uom_code"),
            models.CheckConstraint(condition=Q(decimals__lte=6), name="ck_uom_decimals"),
        ]

    def __str__(self) -> str:
        return self.code


class UomConversion(SharedMasterMixin, ActorStampedModel):
    """1 `from_uom` = `factor` × `to_uom`. Item-specific rows override global ones (e.g. 1 BAG = 50 KG)."""

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey(
        "masterdata.Item", null=True, blank=True, on_delete=models.CASCADE, related_name="conversions"
    )
    from_uom = models.ForeignKey(Uom, on_delete=models.PROTECT, related_name="+")
    to_uom = models.ForeignKey(Uom, on_delete=models.PROTECT, related_name="+")
    factor = RateField()

    authz_resource_type = "masterdata.uom"

    class Meta:
        db_table = "uom_conversions"
        constraints = [
            models.CheckConstraint(condition=Q(factor__gt=0), name="ck_uom_conversion_positive"),
            models.CheckConstraint(condition=~Q(from_uom=F("to_uom")), name="ck_uom_conversion_distinct"),
            models.UniqueConstraint(
                fields=["organization", "item", "from_uom", "to_uom"],
                name="uq_uom_conv_item",
                condition=Q(item__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["organization", "from_uom", "to_uom"], name="uq_uom_conv_global", condition=Q(item__isnull=True)
            ),
        ]


class ItemCategory(SharedMasterMixin, VersionedModel, ActorStampedModel):
    """`posting_group` drives account determination (inventory, COGS, variance accounts)."""

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="children")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=120)
    posting_group = models.CharField(max_length=30)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "masterdata.item_category"

    class Meta:
        db_table = "item_categories"
        verbose_name_plural = "item categories"
        constraints = [models.UniqueConstraint(fields=["organization", "code"], name="uq_item_category_code")]

    def __str__(self) -> str:
        return self.name


class HsnCode(SharedMasterMixin, ActorStampedModel):
    """GST classification. The rate is data, never code (rates change by notification)."""

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    code = models.CharField(max_length=8)
    description = models.CharField(max_length=300)
    gst_rate = PercentField()
    is_service = models.BooleanField(default=False)  # SAC
    is_active = models.BooleanField(default=True)

    authz_resource_type = "masterdata.hsn_code"

    class Meta:
        db_table = "hsn_codes"
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uq_hsn_code"),
            models.CheckConstraint(condition=Q(code__regex=r"^[0-9]{4,8}$"), name="ck_hsn_digits"),
            models.CheckConstraint(condition=Q(gst_rate__gte=0, gst_rate__lte=100), name="ck_hsn_rate"),
        ]


class Item(SharedMasterMixin, VersionedModel, ActorStampedModel):
    class ItemType(models.TextChoices):
        RAW_MATERIAL = "raw_material"
        COMPONENT = "component"
        CONSUMABLE = "consumable"
        SEMI_FINISHED = "semi_finished"
        FINISHED_GOOD = "finished_good"
        SERVICE = "service"
        SPARE = "spare"
        PACKAGING = "packaging"

    class Tracking(models.TextChoices):
        NONE = "none"
        BATCH = "batch"
        SERIAL = "serial"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    code = models.CharField(max_length=40)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    item_type = models.CharField(max_length=20, choices=ItemType.choices)
    category = models.ForeignKey(ItemCategory, on_delete=models.PROTECT, related_name="items")
    stock_uom = models.ForeignKey(Uom, on_delete=models.PROTECT, related_name="+")
    purchase_uom = models.ForeignKey(Uom, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    sales_uom = models.ForeignKey(Uom, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    tracking = models.CharField(max_length=10, choices=Tracking.choices, default=Tracking.NONE)
    shelf_life_days = models.PositiveIntegerField(null=True, blank=True)
    hsn = models.ForeignKey(HsnCode, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    is_stocked = models.BooleanField(default=True)
    is_purchasable = models.BooleanField(default=True)
    is_saleable = models.BooleanField(default=False)
    is_manufactured = models.BooleanField(default=False)
    inspection_required = models.BooleanField(default=False)
    standard_cost = RateField(default=0)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "masterdata.item"

    class Meta:
        db_table = "items"
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uq_item_code"),
            models.CheckConstraint(condition=Q(standard_cost__gte=0), name="ck_item_standard_cost"),
            models.CheckConstraint(
                condition=~Q(item_type="service") | Q(is_stocked=False), name="ck_service_not_stocked"
            ),
        ]
        indexes = [models.Index(fields=["organization", "item_type"], name="ix_item_type")]

    def __str__(self) -> str:
        return f"{self.code} {self.name}"


class ItemBarcode(SharedMasterMixin, ActorStampedModel):
    class Symbology(models.TextChoices):
        CODE128 = "code128"
        EAN13 = "ean13"
        QR = "qr"
        GS1_128 = "gs1_128"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="barcodes")
    barcode = models.CharField(max_length=120)
    symbology = models.CharField(max_length=10, choices=Symbology.choices, default=Symbology.CODE128)
    uom = models.ForeignKey(Uom, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    authz_resource_type = "masterdata.item"

    class Meta:
        db_table = "item_barcodes"
        constraints = [models.UniqueConstraint(fields=["organization", "barcode"], name="uq_item_barcode")]


class ItemWarehousePolicy(AuthzResourceMixin, VersionedModel, ActorStampedModel):
    """Planning parameters per item and warehouse (used by MRP and reorder alerts)."""

    company = models.ForeignKey("organization.Company", on_delete=models.PROTECT, related_name="+")
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="warehouse_policies")
    warehouse = models.ForeignKey("organization.Warehouse", on_delete=models.CASCADE, related_name="+")
    reorder_level = QuantityField(default=0)
    reorder_quantity = QuantityField(default=0)
    min_quantity = QuantityField(default=0)
    max_quantity = QuantityField(null=True, blank=True)
    lead_time_days = models.PositiveIntegerField(default=0)

    authz_resource_type = "masterdata.item_policy"
    authz_scope_fields = {"company": "company_id", "warehouse": "warehouse_id"}

    class Meta:
        db_table = "item_warehouse_policies"
        constraints = [models.UniqueConstraint(fields=["item", "warehouse"], name="uq_item_warehouse_policy")]
