"""UoM conversion and item lookups shared by every transaction module."""

from decimal import ROUND_HALF_UP, Decimal

from apps.core.exceptions import BusinessRuleViolation

from .models import Item, ItemBarcode, Uom, UomConversion

Q6 = Decimal("0.000001")


def conversion_factor(item: Item | None, from_uom: Uom, to_uom: Uom) -> Decimal:
    """Factor f such that qty_in_from × f = qty_in_to. Item-specific beats global; inverse allowed."""
    if from_uom.pk == to_uom.pk:
        return Decimal("1")
    candidates = UomConversion.objects.filter(organization_id=from_uom.organization_id)
    for item_filter in ([{"item": item}] if item is not None else []) + [{"item__isnull": True}]:
        direct = candidates.filter(from_uom=from_uom, to_uom=to_uom, **item_filter).first()
        if direct:
            return direct.factor
        inverse = candidates.filter(from_uom=to_uom, to_uom=from_uom, **item_filter).first()
        if inverse:
            return Decimal("1") / inverse.factor
    raise BusinessRuleViolation(
        f"No conversion from {from_uom.code} to {to_uom.code}" + (f" for {item.code}" if item else "") + ".",
        code="uom_conversion_missing",
    )


def to_stock_qty(item: Item, quantity: Decimal, uom: Uom) -> Decimal:
    qty = (Decimal(quantity) * conversion_factor(item, uom, item.stock_uom)).quantize(Q6, rounding=ROUND_HALF_UP)
    if item.stock_uom.decimals == 0 and qty != qty.to_integral_value():
        raise BusinessRuleViolation(f"{item.code} is counted in whole {item.stock_uom.code}.", code="whole_units_only")
    return qty


def stock_rate(item: Item, rate: Decimal, uom: Uom) -> Decimal:
    """Convert a price per `uom` into a price per stock UoM."""
    return (Decimal(rate) / conversion_factor(item, uom, item.stock_uom)).quantize(Q6, rounding=ROUND_HALF_UP)


def find_by_barcode(organization_id, code: str) -> ItemBarcode | None:
    return (
        ItemBarcode.objects.select_related("item", "uom").filter(organization_id=organization_id, barcode=code).first()
    )
