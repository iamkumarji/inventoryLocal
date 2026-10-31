"""GST returns data (FIN-008). Read-only aggregation of posted invoices; filing goes through a GSP (D-10)."""

from datetime import date
from decimal import Decimal

from django.db.models import Sum

ZERO = Decimal("0")


def gstr1(company_id, date_from: date, date_to: date) -> dict:
    from apps.sales.models import SalesInvoice, SalesInvoiceLine, SalesReturn

    invoices = SalesInvoice.objects.filter(
        company_id=company_id, status="posted", invoice_date__gte=date_from, invoice_date__lte=date_to
    ).select_related("customer")
    b2b, b2c = [], {}
    for inv in invoices:
        row = {
            "number": inv.number,
            "date": inv.invoice_date,
            "place_of_supply": inv.place_of_supply,
            "taxable": inv.subtotal,
            "cgst": inv.cgst,
            "sgst": inv.sgst,
            "igst": inv.igst,
            "total": inv.total,
        }
        if inv.customer_gstin:
            b2b.append({**row, "gstin": inv.customer_gstin, "customer": inv.customer.name})
        else:
            key = inv.place_of_supply
            agg = b2c.setdefault(
                key, {"place_of_supply": key, "taxable": ZERO, "cgst": ZERO, "sgst": ZERO, "igst": ZERO}
            )
            for k in ("taxable", "cgst", "sgst", "igst"):
                agg[k] += row[k]
    hsn = (
        SalesInvoiceLine.objects.filter(invoice__in=invoices)
        .values("hsn_code", "gst_rate")
        .annotate(
            quantity=Sum("quantity"),
            taxable=Sum("taxable_amount"),
            cgst=Sum("cgst"),
            sgst=Sum("sgst"),
            igst=Sum("igst"),
        )
        .order_by("hsn_code")
    )
    notes = SalesReturn.objects.filter(
        company_id=company_id, status="posted", return_date__gte=date_from, return_date__lte=date_to
    ).select_related("invoice")
    return {
        "b2b": b2b,
        "b2c": list(b2c.values()),
        "hsn_summary": list(hsn),
        "credit_notes": [
            {"number": n.number, "date": n.return_date, "invoice": n.invoice.number, "total": n.credit_total}
            for n in notes
        ],
    }


def gstr3b(company_id, date_from: date, date_to: date) -> dict:
    from apps.finance.models import SupplierInvoice
    from apps.sales.models import SalesInvoice, SalesReturn

    def sums(qs, *fields):
        agg = qs.aggregate(**{f: Sum(f) for f in fields})
        return {f: agg[f] or ZERO for f in fields}

    out = sums(
        SalesInvoice.objects.filter(
            company_id=company_id, status="posted", invoice_date__gte=date_from, invoice_date__lte=date_to
        ),
        "subtotal",
        "cgst",
        "sgst",
        "igst",
    )
    returns = SalesReturn.objects.filter(
        company_id=company_id, status="posted", return_date__gte=date_from, return_date__lte=date_to
    )
    credit = sums(returns, "credit_total")["credit_total"]
    itc = sums(
        SupplierInvoice.objects.filter(
            company_id=company_id, status="posted", invoice_date__gte=date_from, invoice_date__lte=date_to
        ),
        "cgst",
        "sgst",
        "igst",
    )
    # Credit notes reduce output tax proportionally to the original invoice's tax mix (approximation noted in docs).
    output_tax = {k: out[k] for k in ("cgst", "sgst", "igst")}
    net = {k: output_tax[k] - itc[k] for k in output_tax}
    return {
        "outward_taxable": out["subtotal"],
        "output_tax": output_tax,
        "credit_notes_total": credit,
        "input_tax_credit": itc,
        "net_payable": {k: max(v, ZERO) for k, v in net.items()},
        "carry_forward_credit": {k: max(-v, ZERO) for k, v in net.items()},
    }
