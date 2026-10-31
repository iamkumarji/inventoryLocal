"""GST computation (FIN-008). Rates come from HSN master data; the split depends on place of supply."""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

Q2 = Decimal("0.01")
HUNDRED = Decimal("100")


@dataclass
class TaxSplit:
    taxable: Decimal
    rate: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal

    @property
    def total_tax(self) -> Decimal:
        return self.cgst + self.sgst + self.igst


def line_amounts(quantity, rate, discount_pct, gst_rate, *, intra_state: bool) -> TaxSplit:
    gross = Decimal(quantity) * Decimal(rate)
    taxable = (gross * (1 - Decimal(discount_pct or 0) / HUNDRED)).quantize(Q2, rounding=ROUND_HALF_UP)
    gst_rate = Decimal(gst_rate or 0)
    tax = (taxable * gst_rate / HUNDRED).quantize(Q2, rounding=ROUND_HALF_UP)
    if intra_state:
        cgst = (tax / 2).quantize(Q2, rounding=ROUND_HALF_UP)
        return TaxSplit(taxable, gst_rate, cgst, tax - cgst, Decimal("0"))
    return TaxSplit(taxable, gst_rate, Decimal("0"), Decimal("0"), tax)


def is_intra_state(our_state: str, their_state: str) -> bool:
    """Same state => CGST+SGST; otherwise IGST. Unknown state on either side defaults to IGST."""
    return bool(our_state) and our_state == their_state
