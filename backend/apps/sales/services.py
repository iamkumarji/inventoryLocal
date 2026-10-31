"""Order-to-Cash (SRS §3.10): quotation → order (credit check, reservation) → delivery (COGS) →
GST invoice (AR) → receipt (finance) → returns (credit notes)."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.db.models import F, Sum
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition
from apps.core.outbox import publish_event
from apps.finance.models import OpenItem
from apps.finance.posting import Line, post_journal
from apps.finance.subledger import create_open_item, overdue_days, partner_exposure
from apps.inventory.engine import Move, get_or_create_batch, post_stock, reserve
from apps.inventory.models import StockBalance, StockStatus
from apps.masterdata.services import conversion_factor, to_stock_qty
from apps.organization.services import allocate_number
from apps.shared import workflow
from apps.shared.tax import is_intra_state, line_amounts

from .models import (
    Delivery,
    DeliveryLine,
    SalesInvoice,
    SalesInvoiceLine,
    SalesOrder,
    SalesOrderLine,
    SalesQuotation,
    SalesQuotationLine,
    SalesReturn,
    SalesReturnLine,
)

SO = "sales.sales_order"
Q2 = Decimal("0.01")
Q6 = Decimal("0.000001")
ZERO = Decimal("0")


def _customer_profile(customer):
    from apps.partners.models import CustomerProfile

    profile = CustomerProfile.objects.filter(partner=customer).first()
    if not customer.is_customer or profile is None:
        raise ValidationError({"customer": ["Not a customer."]})
    if customer.is_blocked or not customer.is_active:
        raise BusinessRuleViolation(f"{customer.name} is blocked.", code="customer_blocked")
    return profile


def _price_lines(model, parent_field, parent, lines, intra) -> tuple[Decimal, Decimal]:
    subtotal = tax = ZERO
    for n, line in enumerate(lines, start=1):
        item = line["item"]
        if not item.is_saleable:
            raise ValidationError({"lines": [f"{item.code} isn't for sale."]})
        gst = item.hsn.gst_rate if item.hsn else ZERO
        split = line_amounts(line["quantity"], line["rate"], line.get("discount_pct", 0), gst, intra_state=intra)
        extra = {"line_no": n} if model is SalesOrderLine else {}
        if model is SalesOrderLine:
            extra.update(warehouse=line["warehouse"], stock_quantity=to_stock_qty(item, line["quantity"], line["uom"]))
        model.objects.create(
            **{parent_field: parent},
            item=item,
            quantity=line["quantity"],
            uom=line["uom"],
            rate=line["rate"],
            discount_pct=line.get("discount_pct", 0),
            gst_rate=gst,
            taxable_amount=split.taxable,
            cgst=split.cgst,
            sgst=split.sgst,
            igst=split.igst,
            **extra,
        )
        subtotal += split.taxable
        tax += split.total_tax
    return subtotal, tax


@transaction.atomic
def create_quotation(
    ctx: ActorContext,
    *,
    company,
    branch,
    customer,
    quote_date: date,
    valid_until: date,
    lines: list[dict],
    notes: str = "",
) -> SalesQuotation:
    pdp.require(
        ctx, "sales.quotation.create", pdp.Resource.ref("sales.quotation", company_id=company.pk, branch_id=branch.pk)
    )
    _customer_profile(customer)
    intra = is_intra_state(branch.state_code or company.state_code, customer.state_code)
    q = SalesQuotation.objects.create(
        company=company,
        branch=branch,
        customer=customer,
        quote_date=quote_date,
        valid_until=valid_until,
        intra_state=intra,
        notes=notes,
        created_by=ctx.user,
        updated_by=ctx.user,
        number=allocate_number(company.pk, "SQ", quote_date),
    )
    subtotal, tax = _price_lines(SalesQuotationLine, "quotation", q, lines, intra)
    q.amount = subtotal + tax
    q.save(update_fields=["amount"])
    return q


@transaction.atomic
def create_order(
    ctx: ActorContext,
    *,
    company,
    branch,
    customer,
    order_date: date,
    requested_date: date,
    lines: list[dict],
    customer_po: str = "",
    place_of_supply: str = "",
    quotation=None,
) -> SalesOrder:
    pdp.require(ctx, f"{SO}.create", pdp.Resource.ref(SO, company_id=company.pk, branch_id=branch.pk))
    _customer_profile(customer)
    if not lines:
        raise ValidationError({"lines": ["Add at least one line."]})
    pos = place_of_supply or customer.state_code
    intra = is_intra_state(branch.state_code or company.state_code, pos)
    order = SalesOrder.objects.create(
        company=company,
        branch=branch,
        customer=customer,
        order_date=order_date,
        requested_date=requested_date,
        customer_po=customer_po,
        place_of_supply=pos,
        intra_state=intra,
        quotation=quotation,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for line in lines:
        if line["warehouse"].company_id != company.pk:
            raise ValidationError({"lines": ["Warehouse belongs to another company."]})
    order.subtotal, order.tax_total = _price_lines(SalesOrderLine, "order", order, lines, intra)
    order.amount = order.subtotal + order.tax_total
    order.number = allocate_number(company.pk, "SO", order_date)
    order.save()
    if quotation is not None:
        SalesQuotation.objects.filter(pk=quotation.pk).update(status="accepted")
    return order


@transaction.atomic
def convert_quotation(
    ctx: ActorContext, quotation: SalesQuotation, *, warehouse, order_date: date, requested_date: date
) -> SalesOrder:
    if quotation.status != "open" or quotation.valid_until < order_date:
        raise BusinessRuleViolation("The quotation is no longer valid.", code="quotation_expired")
    lines = [
        {
            "item": ql.item,
            "quantity": ql.quantity,
            "uom": ql.uom,
            "rate": ql.rate,
            "discount_pct": ql.discount_pct,
            "warehouse": warehouse,
        }
        for ql in quotation.lines.select_related("item__hsn")
    ]
    return create_order(
        ctx,
        company=quotation.company,
        branch=quotation.branch,
        customer=quotation.customer,
        order_date=order_date,
        requested_date=requested_date,
        lines=lines,
        quotation=quotation,
    )


def open_order_value(company_id, customer_id, exclude_id=None) -> Decimal:
    total = ZERO
    orders = SalesOrder.objects.filter(company_id=company_id, customer_id=customer_id, status="approved")
    if exclude_id:
        orders = orders.exclude(pk=exclude_id)
    for line in SalesOrderLine.objects.filter(order__in=orders):
        if line.stock_quantity:
            share = (line.stock_quantity - line.invoiced_quantity) / line.stock_quantity
            total += (line.taxable_amount + line.cgst + line.sgst + line.igst) * share
    return total.quantize(Q2)


def credit_check(order: SalesOrder, on: date) -> tuple[str, str]:
    profile = _customer_profile(order.customer)
    if profile.on_credit_hold:
        return "blocked", "Customer is on credit hold."
    overdue = overdue_days(order.company_id, order.customer_id, on)
    if overdue > 0:
        return "blocked", f"Invoices overdue by {overdue} days."
    exposure = (
        partner_exposure(order.company_id, order.customer_id)
        + open_order_value(order.company_id, order.customer_id, exclude_id=order.pk)
        + order.amount
    )
    if exposure > profile.credit_limit:
        return "blocked", f"Exposure {exposure} exceeds the credit limit {profile.credit_limit}."
    return "ok", ""


def _reserve(ctx: ActorContext, order: SalesOrder) -> None:
    from apps.inventory.selectors import availability

    for line in order.lines.select_related("item", "warehouse"):
        if not line.item.is_stocked:
            continue
        free = availability(order.company_id, line.item_id, line.warehouse_id)["available"]
        qty = min(max(free, ZERO), line.stock_quantity)
        if qty > 0:
            line.reservation = reserve(
                ctx,
                company_id=order.company_id,
                item=line.item,
                warehouse=line.warehouse,
                quantity=qty,
                source_type=SO,
                source_id=order.pk,
                source_line_id=line.pk,
            )
            line.reserved_quantity = qty
            line.save(update_fields=["reservation", "reserved_quantity"])


@transaction.atomic
def submit_order(ctx: ActorContext, order: SalesOrder, *, on: date, expected_version=None) -> SalesOrder:
    order = SalesOrder.objects.select_for_update().select_related("customer").get(pk=order.pk)
    workflow.check(order, expected_version, "draft", "rejected")
    pdp.require(ctx, f"{SO}.update", pdp.Resource.of(order))
    status, note = credit_check(order, on)
    if status == "ok":  # passing the credit check is the approval for standard orders
        workflow.bump(order, ctx, status="approved", credit_status="ok", credit_note="", submitted_by=ctx.user)
        _reserve(ctx, order)
        publish_event("sales.order.approved", aggregate_type=SO, aggregate_id=order.pk, company_id=order.company_id)
    else:
        workflow.bump(order, ctx, status="submitted", credit_status="blocked", credit_note=note, submitted_by=ctx.user)
    audit.record(
        f"{SO}.submitted",
        ctx=ctx,
        resource_type=SO,
        resource_id=order.pk,
        company_id=order.company_id,
        summary=f"{order.number}: credit {order.credit_status}",
        changes={"note": note},
    )
    return order


@transaction.atomic
def decide_credit(ctx: ActorContext, order: SalesOrder, *, approve: bool, note: str) -> SalesOrder:
    order = SalesOrder.objects.select_for_update().get(pk=order.pk)
    if order.status != "submitted" or order.credit_status != "blocked":
        raise InvalidStateTransition("Only credit-blocked orders need an override decision.")
    if ctx.user_id in (order.created_by_id, order.submitted_by_id):
        raise AuthorizationDenied(reason="self_approval")
    pdp.require(ctx, f"{SO}.credit_override", pdp.Resource.of(order))
    if not note.strip():
        raise ValidationError({"note": ["Record why the credit block is overridden or upheld."]})
    if approve:
        workflow.bump(
            order,
            ctx,
            status="approved",
            credit_status="overridden",
            approved_by=ctx.user,
            credit_note=f"{order.credit_note} Override: {note}"[:300],
        )
        _reserve(ctx, order)
    else:
        workflow.bump(order, ctx, status="rejected", credit_note=f"{order.credit_note} Upheld: {note}"[:300])
    audit.record(
        f"{SO}.credit_{'overridden' if approve else 'upheld'}",
        ctx=ctx,
        resource_type=SO,
        resource_id=order.pk,
        company_id=order.company_id,
        summary=note,
    )
    return order


# --- Deliveries ---------------------------------------------------------------------------------------


def fefo_batches(company_id, item, warehouse) -> list[dict]:
    """First-expiry-first-out suggestion for picking."""
    rows = (
        StockBalance.objects.filter(
            company_id=company_id,
            item=item,
            warehouse=warehouse,
            stock_status=StockStatus.UNRESTRICTED,
            quantity__gt=0,
            batch__isnull=False,
        )
        .values("batch_id", "batch__batch_number", "batch__expires_on")
        .annotate(q=Sum("quantity"))
        .order_by("batch__expires_on", "batch__batch_number")
    )
    return [
        {
            "batch_id": str(r["batch_id"]),
            "batch_number": r["batch__batch_number"],
            "expires_on": r["batch__expires_on"],
            "quantity": r["q"],
        }
        for r in rows
    ]


@transaction.atomic
def create_delivery(
    ctx: ActorContext, *, order: SalesOrder, warehouse, delivery_date: date, lines: list[dict]
) -> Delivery:
    pdp.require(
        ctx,
        "sales.delivery.create",
        pdp.Resource.ref("sales.delivery", company_id=order.company_id, warehouse_id=warehouse.pk),
    )
    if order.status != "approved":
        raise BusinessRuleViolation("Only approved orders can be delivered.", code="so_not_approved")
    delivery = Delivery.objects.create(
        company_id=order.company_id,
        sales_order=order,
        customer=order.customer,
        warehouse=warehouse,
        delivery_date=delivery_date,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for line in lines:
        so_line = line["so_line"]
        if so_line.order_id != order.pk or so_line.warehouse_id != warehouse.pk:
            raise ValidationError({"lines": ["Line belongs to another order or warehouse."]})
        batch = (
            get_or_create_batch(order.company_id, so_line.item, line["batch_number"], create=False)
            if line.get("batch_number")
            else None
        )
        DeliveryLine.objects.create(
            delivery=delivery,
            so_line=so_line,
            quantity=line["quantity"],
            batch=batch,
            serials=line.get("serials", []),
            location=line.get("location"),
        )
    return delivery


@transaction.atomic
def post_delivery(ctx: ActorContext, delivery: Delivery, expected_version=None) -> Delivery:
    delivery = (
        Delivery.objects.select_for_update(of=("self",)).select_related("warehouse", "customer").get(pk=delivery.pk)
    )
    workflow.check(delivery, expected_version, "draft")
    pdp.require(ctx, "sales.delivery.post", pdp.Resource.of(delivery))
    moves = []
    for line in delivery.lines.select_related("so_line__item__category", "so_line__reservation", "batch", "location"):
        so_line = SalesOrderLine.objects.select_for_update().get(pk=line.so_line_id)
        if so_line.delivered_quantity + line.quantity > so_line.stock_quantity:
            raise BusinessRuleViolation(f"{line.so_line.item.code}: more than ordered.", code="over_delivery")
        moves.append(
            Move(
                item=line.so_line.item,
                warehouse=delivery.warehouse,
                quantity=-line.quantity,
                movement_type="sales_issue",
                batch=line.batch,
                location=line.location,
                serials=list(line.serials),
                consume_reservation=line.so_line.reservation,
                contra_key="cogs",
                partner_id=delivery.customer_id,
                source_line_id=line.pk,
            )
        )
        so_line.delivered_quantity += line.quantity
        so_line.reserved_quantity = max(so_line.reserved_quantity - line.quantity, ZERO)
        so_line.save(update_fields=["delivered_quantity", "reserved_quantity"])
    delivery.number = allocate_number(delivery.company_id, "DN", delivery.delivery_date)
    delivery.stock_transaction = post_stock(
        ctx,
        company_id=delivery.company_id,
        posting_date=delivery.delivery_date,
        moves=moves,
        source_type="sales.delivery",
        source_id=delivery.pk,
        reference=delivery.number,
        narration=f"Delivery {delivery.number} to {delivery.customer.name}",
    )
    for move in moves:
        DeliveryLine.objects.filter(pk=move.source_line_id).update(cost_value=-move.value)
    workflow.bump(delivery, ctx, status="posted")
    publish_event(
        "sales.delivery.posted",
        aggregate_type="sales.delivery",
        aggregate_id=delivery.pk,
        company_id=delivery.company_id,
    )
    return delivery


# --- Invoices -----------------------------------------------------------------------------------------


@transaction.atomic
def create_invoice(
    ctx: ActorContext, *, order: SalesOrder, invoice_date: date, lines: list[dict] | None = None
) -> SalesInvoice:
    """lines: [{so_line, quantity (stock UoM)}]; default = everything delivered and not yet invoiced."""
    pdp.require(
        ctx,
        "sales.invoice.create",
        pdp.Resource.ref("sales.invoice", company_id=order.company_id, branch_id=order.branch_id),
    )
    profile = _customer_profile(order.customer)
    if lines is None:
        lines = [
            {"so_line": sl, "quantity": sl.delivered_quantity - sl.invoiced_quantity}
            for sl in order.lines.all()
            if sl.delivered_quantity > sl.invoiced_quantity
        ]
    if not lines:
        raise BusinessRuleViolation("Nothing delivered is waiting to be invoiced.", code="nothing_to_invoice")
    inv = SalesInvoice.objects.create(
        company_id=order.company_id,
        sales_order=order,
        customer=order.customer,
        branch=order.branch,
        invoice_date=invoice_date,
        due_date=invoice_date + timedelta(days=profile.credit_days),
        place_of_supply=order.place_of_supply,
        intra_state=order.intra_state,
        customer_gstin=order.customer.gstin,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for line in lines:
        so_line = line["so_line"]
        qty = Decimal(line["quantity"])
        if so_line.order_id != order.pk:
            raise ValidationError({"lines": ["Line belongs to another order."]})
        factor = conversion_factor(so_line.item, so_line.uom, so_line.item.stock_uom)
        stock_rate = (so_line.rate * (1 - so_line.discount_pct / 100) / factor).quantize(Q6, rounding=ROUND_HALF_UP)
        split = line_amounts(qty, stock_rate, 0, so_line.gst_rate, intra_state=order.intra_state)
        SalesInvoiceLine.objects.create(
            invoice=inv,
            so_line=so_line,
            item=so_line.item,
            hsn_code=so_line.item.hsn.code if so_line.item.hsn else "",
            quantity=qty,
            rate=stock_rate,
            gst_rate=so_line.gst_rate,
            taxable_amount=split.taxable,
            cgst=split.cgst,
            sgst=split.sgst,
            igst=split.igst,
        )
    _totals(inv)
    return inv


def _totals(inv: SalesInvoice) -> None:
    agg = inv.lines.aggregate(s=Sum("taxable_amount"), c=Sum("cgst"), g=Sum("sgst"), i=Sum("igst"))
    inv.subtotal, inv.cgst, inv.sgst, inv.igst = (agg[k] or ZERO for k in ("s", "c", "g", "i"))
    inv.total = inv.subtotal + inv.cgst + inv.sgst + inv.igst
    inv.save(update_fields=["subtotal", "cgst", "sgst", "igst", "total"])


@transaction.atomic
def post_invoice(ctx: ActorContext, inv: SalesInvoice, expected_version=None) -> SalesInvoice:
    inv = SalesInvoice.objects.select_for_update().select_related("customer").get(pk=inv.pk)
    workflow.check(inv, expected_version, "draft")
    pdp.require(ctx, "sales.invoice.post", pdp.Resource.of(inv))
    lines = [Line(amount=inv.total, key="ar", partner_id=inv.customer_id)]
    for key, amount in (("gst_output_cgst", inv.cgst), ("gst_output_sgst", inv.sgst), ("gst_output_igst", inv.igst)):
        lines.append(Line(amount=-amount, key=key))
    for line in inv.lines.select_related("item__category"):
        so_line = SalesOrderLine.objects.select_for_update().get(pk=line.so_line_id)
        if so_line.invoiced_quantity + line.quantity > so_line.delivered_quantity:
            raise BusinessRuleViolation(
                f"{line.item.code}: invoice exceeds delivered quantity.", code="invoice_exceeds_delivery"
            )
        so_line.invoiced_quantity += line.quantity
        so_line.save(update_fields=["invoiced_quantity"])
        lines.append(
            Line(
                amount=-line.taxable_amount,
                key="sales_revenue",
                posting_group=line.item.category.posting_group,
                item_id=line.item_id,
            )
        )
    inv.number = allocate_number(inv.company_id, "SI", inv.invoice_date)  # gapless per GST rules
    inv.journal_entry = post_journal(
        ctx,
        company_id=inv.company_id,
        entry_date=inv.invoice_date,
        lines=lines,
        narration=f"Sales invoice {inv.number} to {inv.customer.name}",
        source_module="sales",
        source_type="sales.invoice",
        source_id=inv.pk,
    )
    create_open_item(
        company_id=inv.company_id,
        partner_id=inv.customer_id,
        kind=OpenItem.Kind.RECEIVABLE,
        document_type="sales.invoice",
        document_id=inv.pk,
        number=inv.number,
        document_date=inv.invoice_date,
        due_date=inv.due_date,
        amount=inv.total,
    )
    workflow.bump(inv, ctx, status="posted")
    audit.record(
        "sales.invoice.posted",
        ctx=ctx,
        resource_type="sales.invoice",
        resource_id=inv.pk,
        company_id=inv.company_id,
        summary=f"{inv.number} {inv.total}",
    )
    publish_event(
        "sales.invoice.posted", aggregate_type="sales.invoice", aggregate_id=inv.pk, company_id=inv.company_id
    )
    return inv


# --- Returns (credit notes) -------------------------------------------------------------------------------


@transaction.atomic
def create_return(
    ctx: ActorContext, *, invoice: SalesInvoice, warehouse, return_date: date, reason: str, lines: list[dict]
) -> SalesReturn:
    pdp.require(
        ctx,
        "sales.sales_return.create",
        pdp.Resource.ref("sales.sales_return", company_id=invoice.company_id, warehouse_id=warehouse.pk),
    )
    if invoice.status != "posted":
        raise BusinessRuleViolation("Returns are recorded against posted invoices.", code="invoice_not_posted")
    ret = SalesReturn.objects.create(
        company_id=invoice.company_id,
        invoice=invoice,
        customer=invoice.customer,
        warehouse=warehouse,
        return_date=return_date,
        reason=reason,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for line in lines:
        if line["invoice_line"].invoice_id != invoice.pk:
            raise ValidationError({"lines": ["Line belongs to another invoice."]})
        SalesReturnLine.objects.create(sales_return=ret, **line)
    return ret


@transaction.atomic
def post_return(ctx: ActorContext, ret: SalesReturn, expected_version=None) -> SalesReturn:
    ret = (
        SalesReturn.objects.select_for_update(of=("self",))
        .select_related("warehouse", "customer", "invoice")
        .get(pk=ret.pk)
    )
    workflow.check(ret, expected_version, "draft")
    pdp.require(ctx, "sales.sales_return.post", pdp.Resource.of(ret))
    moves, gl = [], []
    taxable = cgst = sgst = igst = ZERO
    for line in ret.lines.select_related("invoice_line__item__category", "invoice_line__so_line", "batch"):
        inv_line = SalesInvoiceLine.objects.select_for_update().get(pk=line.invoice_line_id)
        if inv_line.returned_quantity + line.quantity > inv_line.quantity:
            raise BusinessRuleViolation("Return exceeds the invoiced quantity.", code="over_return")
        share = line.quantity / inv_line.quantity
        t, c, s, i = (
            (v * share).quantize(Q2, rounding=ROUND_HALF_UP)
            for v in (inv_line.taxable_amount, inv_line.cgst, inv_line.sgst, inv_line.igst)
        )
        taxable, cgst, sgst, igst = taxable + t, cgst + c, sgst + s, igst + i
        gl.append(
            Line(
                amount=t,
                key="sales_returns",
                posting_group=inv_line.item.category.posting_group,
                item_id=inv_line.item_id,
            )
        )
        delivered = DeliveryLine.objects.filter(so_line_id=inv_line.so_line_id, delivery__status="posted").aggregate(
            q=Sum("quantity"), v=Sum("cost_value")
        )
        unit_cost = (delivered["v"] / delivered["q"]) if delivered["q"] else inv_line.item.standard_cost
        if inv_line.item.is_stocked:
            moves.append(
                Move(
                    item=inv_line.item,
                    warehouse=ret.warehouse,
                    quantity=line.quantity,
                    movement_type="sales_return",
                    stock_status=StockStatus.UNRESTRICTED if line.restock else StockStatus.BLOCKED,
                    batch=line.batch,
                    serials=list(line.serials),
                    unit_cost=unit_cost,
                    contra_key="cogs",
                    partner_id=ret.customer_id,
                    source_line_id=line.pk,
                )
            )
        inv_line.returned_quantity += line.quantity
        inv_line.save(update_fields=["returned_quantity"])
        SalesOrderLine.objects.filter(pk=inv_line.so_line_id).update(
            returned_quantity=F("returned_quantity") + line.quantity
        )
    total = taxable + cgst + sgst + igst
    gl += [
        Line(amount=cgst, key="gst_output_cgst"),
        Line(amount=sgst, key="gst_output_sgst"),
        Line(amount=igst, key="gst_output_igst"),
        Line(amount=-total, key="ar", partner_id=ret.customer_id),
    ]
    ret.number = allocate_number(ret.company_id, "CN", ret.return_date)
    if moves:
        ret.stock_transaction = post_stock(
            ctx,
            company_id=ret.company_id,
            posting_date=ret.return_date,
            moves=moves,
            source_type="sales.sales_return",
            source_id=ret.pk,
            reference=ret.number,
            narration=f"Sales return {ret.number}",
        )
    ret.journal_entry = post_journal(
        ctx,
        company_id=ret.company_id,
        entry_date=ret.return_date,
        lines=gl,
        narration=f"Credit note {ret.number} on {ret.invoice.number}",
        source_module="sales",
        source_type="sales.sales_return",
        source_id=ret.pk,
    )
    create_open_item(
        company_id=ret.company_id,
        partner_id=ret.customer_id,
        kind=OpenItem.Kind.RECEIVABLE,
        document_type="sales.sales_return",
        document_id=ret.pk,
        number=ret.number,
        document_date=ret.return_date,
        due_date=ret.return_date,
        amount=-total,
    )
    ret.credit_total = total
    workflow.bump(ret, ctx, status="posted")
    return ret
