"""Procure-to-Pay up to goods receipt (SRS §3.7). Supplier invoices and payments are in finance (AP)."""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import BusinessRuleViolation, InvalidStateTransition
from apps.core.outbox import publish_event
from apps.inventory.engine import Move, get_or_create_batch, post_stock
from apps.inventory.models import StockStatus
from apps.masterdata.services import stock_rate, to_stock_qty
from apps.organization.services import allocate_number
from apps.quality import services as quality
from apps.shared import workflow
from apps.shared.tax import is_intra_state, line_amounts

from .models import (
    GoodsReceipt,
    GoodsReceiptLine,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseRequisition,
    PurchaseReturn,
    PurchaseReturnLine,
    QuotationLine,
    RequestForQuotation,
    RequisitionLine,
    RFQLine,
    SupplierQuotation,
)

PR = "procurement.purchase_requisition"
PO = "procurement.purchase_order"
GRN = "procurement.goods_receipt"
Q2 = Decimal("0.01")


# --- Requisitions --------------------------------------------------------------------------------


@transaction.atomic
def create_requisition(
    ctx: ActorContext, *, company, branch, needed_by: date, purpose: str, lines: list[dict], department=None
) -> PurchaseRequisition:
    pdp.require(
        ctx,
        f"{PR}.create",
        pdp.Resource.ref(
            PR, company_id=company.pk, branch_id=branch.pk, department_id=department.pk if department else None
        ),
    )
    if not lines:
        raise ValidationError({"lines": ["Add at least one item."]})
    pr = PurchaseRequisition.objects.create(
        company=company,
        branch=branch,
        department=department,
        needed_by=needed_by,
        purpose=purpose,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    total = Decimal("0")
    for line in lines:
        if not line["item"].is_purchasable:
            raise ValidationError({"lines": [f"{line['item'].code} can't be purchased."]})
        RequisitionLine.objects.create(requisition=pr, **line)
        total += Decimal(line["quantity"]) * Decimal(line.get("estimated_rate") or 0)
    pr.amount = total.quantize(Q2)
    pr.number = allocate_number(company.pk, "PR", timezone.localdate())
    pr.save(update_fields=["amount", "number"])
    return pr


def submit_requisition(ctx, pr, expected_version=None):
    return workflow.submit(
        ctx,
        pr,
        document_type=PR,
        title=f"Purchase requisition: {pr.purpose}",
        summary={"needed_by": str(pr.needed_by), "lines": pr.lines.count()},
        scope={"branch_id": pr.branch_id, "department_id": pr.department_id},
        expected_version=expected_version,
    )


# --- RFQ and quotations ----------------------------------------------------------------------------


@transaction.atomic
def create_rfq(
    ctx: ActorContext,
    *,
    company,
    branch,
    respond_by: date,
    suppliers: list,
    lines: list[dict] | None = None,
    requisition=None,
    notes: str = "",
) -> RequestForQuotation:
    pdp.require(
        ctx, "procurement.rfq.create", pdp.Resource.ref("procurement.rfq", company_id=company.pk, branch_id=branch.pk)
    )
    if requisition is not None and requisition.status != "approved":
        raise BusinessRuleViolation("Only approved requisitions can go out for quotation.", code="pr_not_approved")
    if len(suppliers) < 1:
        raise ValidationError({"suppliers": ["Invite at least one supplier."]})
    for supplier in suppliers:
        if not supplier.is_supplier or supplier.is_blocked:
            raise ValidationError({"suppliers": [f"{supplier.name} can't be invited."]})
    rfq = RequestForQuotation.objects.create(
        company=company,
        branch=branch,
        respond_by=respond_by,
        requisition=requisition,
        notes=notes,
        created_by=ctx.user,
        updated_by=ctx.user,
        number=allocate_number(company.pk, "RFQ", timezone.localdate()),
    )
    rfq.suppliers.set(suppliers)
    if requisition is not None and not lines:
        lines = [
            {"item": rl.item, "quantity": rl.quantity, "uom": rl.uom, "requisition_line": rl}
            for rl in requisition.lines.all()
        ]
    if not lines:
        raise ValidationError({"lines": ["Add items, or start from an approved requisition."]})
    for line in lines:
        RFQLine.objects.create(rfq=rfq, **line)
    return rfq


@transaction.atomic
def record_quotation(
    ctx: ActorContext,
    rfq: RequestForQuotation,
    *,
    supplier,
    received_on: date,
    valid_until: date,
    lead_time_days: int,
    lines: list[dict],
    payment_terms_days: int = 30,
    supplier_reference: str = "",
) -> SupplierQuotation:
    pdp.require(ctx, "procurement.rfq.update", pdp.Resource.of(rfq))
    if rfq.status != "open":
        raise InvalidStateTransition("The RFQ is closed.")
    if not rfq.suppliers.filter(pk=supplier.pk).exists():
        raise ValidationError({"supplier": ["This supplier wasn't invited to the RFQ."]})
    quote = SupplierQuotation.objects.create(
        company_id=rfq.company_id,
        rfq=rfq,
        supplier=supplier,
        received_on=received_on,
        valid_until=valid_until,
        lead_time_days=lead_time_days,
        payment_terms_days=payment_terms_days,
        supplier_reference=supplier_reference,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    total = Decimal("0")
    for line in lines:
        if line["rfq_line"].rfq_id != rfq.pk:
            raise ValidationError({"lines": ["Line doesn't belong to this RFQ."]})
        QuotationLine.objects.create(quotation=quote, **line)
        total += line_amounts(
            line["rfq_line"].quantity, line["rate"], line.get("discount_pct", 0), 0, intra_state=True
        ).taxable
    quote.total = total
    quote.save(update_fields=["total"])
    return quote


def compare_quotations(
    rfq: RequestForQuotation, *, price_weight=Decimal("0.6"), lead_weight=Decimal("0.2"), quality_weight=Decimal("0.2")
) -> list[dict]:
    """Weighted ranking: cheapest total, fastest lead time and best supplier quality score 100 each."""
    quotes = list(
        rfq.quotations.select_related("supplier__supplier_profile").filter(valid_until__gte=timezone.localdate())
    )
    complete = [q for q in quotes if q.lines.count() == rfq.lines.count()]
    if not complete:
        return []
    best_total = min(q.total for q in complete) or Decimal("1")
    best_lead = min(q.lead_time_days for q in complete) or 1
    rows = []
    for q in complete:
        rating = getattr(getattr(q.supplier, "supplier_profile", None), "rating", None)
        price_score = Decimal(best_total) / q.total * 100 if q.total else Decimal(100)
        lead_score = Decimal(best_lead) / max(q.lead_time_days, 1) * 100
        quality_score = rating if rating is not None else Decimal(50)  # unrated suppliers get a neutral score
        score = price_weight * price_score + lead_weight * lead_score + quality_weight * quality_score
        rows.append(
            {
                "quotation_id": str(q.pk),
                "supplier": q.supplier.name,
                "total": q.total,
                "lead_time_days": q.lead_time_days,
                "supplier_rating": rating,
                "score": score.quantize(Q2),
                "is_cheapest": q.total == best_total,
            }
        )
    return sorted(rows, key=lambda r: -r["score"])


@transaction.atomic
def select_quotation(ctx: ActorContext, quote: SupplierQuotation, *, reason: str, warehouse, expected_date: date):
    quote = SupplierQuotation.objects.select_for_update(of=("self",)).select_related("rfq").get(pk=quote.pk)
    rfq = quote.rfq
    pdp.require(ctx, "procurement.rfq.approve", pdp.Resource.of(rfq))
    ranking = compare_quotations(rfq)
    chosen = next((r for r in ranking if r["quotation_id"] == str(quote.pk)), None)
    if chosen is None:
        raise BusinessRuleViolation("This quotation is incomplete or has expired.", code="quotation_invalid")
    if not chosen["is_cheapest"] and not reason.strip():
        raise ValidationError({"reason": ["Explain why a quotation other than the cheapest is chosen."]})
    rfq.quotations.exclude(pk=quote.pk).update(status="not_selected")
    quote.status, quote.selection_reason = "selected", reason
    quote.save(update_fields=["status", "selection_reason"])
    RequestForQuotation.objects.filter(pk=rfq.pk).update(status="closed")
    lines = [
        {
            "item": ql.rfq_line.item,
            "quantity": ql.rfq_line.quantity,
            "uom": ql.rfq_line.uom,
            "rate": ql.rate,
            "discount_pct": ql.discount_pct,
            "warehouse": warehouse,
            "requisition_line": ql.rfq_line.requisition_line,
        }
        for ql in quote.lines.select_related("rfq_line__item__hsn", "rfq_line__uom")
    ]
    # The selector decides; the PO is drafted for the buyer who ran the RFQ, so the selector can still
    # approve the PO independently (maker-checker). The buyer's own create permission is checked.
    return create_order(
        replace(ctx, user=rfq.created_by),
        company=rfq.company,
        branch=rfq.branch,
        supplier=quote.supplier,
        order_date=timezone.localdate(),
        expected_date=expected_date,
        lines=lines,
        payment_terms_days=quote.payment_terms_days,
        quotation=quote,
        requisition=rfq.requisition,
    )


# --- Purchase orders -----------------------------------------------------------------------------------


def _check_supplier(supplier) -> None:
    from apps.partners.models import SupplierProfile

    profile = SupplierProfile.objects.filter(partner=supplier).first()  # never trust a cached relation here
    if not supplier.is_supplier or profile is None:
        raise ValidationError({"supplier": ["Not a supplier."]})
    if supplier.is_blocked or not supplier.is_active:
        raise BusinessRuleViolation(f"{supplier.name} is blocked.", code="supplier_blocked")
    if not profile.is_approved_vendor:
        raise BusinessRuleViolation(f"{supplier.name} isn't an approved vendor yet.", code="supplier_not_approved")


def _terms(supplier) -> int:
    from apps.partners.models import SupplierProfile

    return SupplierProfile.objects.get(partner=supplier).payment_terms_days


@transaction.atomic
def create_order(
    ctx: ActorContext,
    *,
    company,
    branch,
    supplier,
    order_date: date,
    expected_date: date,
    lines: list[dict],
    payment_terms_days: int | None = None,
    quotation=None,
    requisition=None,
    notes: str = "",
) -> PurchaseOrder:
    pdp.require(ctx, f"{PO}.create", pdp.Resource.ref(PO, company_id=company.pk, branch_id=branch.pk))
    _check_supplier(supplier)
    if not lines:
        raise ValidationError({"lines": ["Add at least one line."]})
    our_state = branch.state_code or company.state_code
    intra = is_intra_state(our_state, supplier.state_code)
    po = PurchaseOrder.objects.create(
        company=company,
        branch=branch,
        supplier=supplier,
        order_date=order_date,
        expected_date=expected_date,
        payment_terms_days=payment_terms_days or _terms(supplier),
        quotation=quotation,
        requisition=requisition,
        intra_state=intra,
        notes=notes,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    subtotal = tax = Decimal("0")
    for n, line in enumerate(lines, start=1):
        item, warehouse = line["item"], line["warehouse"]
        if not item.is_purchasable:
            raise ValidationError({"lines": [f"{item.code} can't be purchased."]})
        if warehouse.company_id != company.pk:
            raise ValidationError({"lines": ["Delivery warehouse belongs to another company."]})
        to_stock_qty(item, line["quantity"], line["uom"]) if item.is_stocked else None  # validates the UoM
        gst = item.hsn.gst_rate if item.hsn else Decimal("0")
        split = line_amounts(line["quantity"], line["rate"], line.get("discount_pct", 0), gst, intra_state=intra)
        PurchaseOrderLine.objects.create(
            order=po,
            line_no=n,
            item=item,
            description=line.get("description", ""),
            quantity=line["quantity"],
            uom=line["uom"],
            rate=line["rate"],
            discount_pct=line.get("discount_pct", 0),
            gst_rate=gst,
            taxable_amount=split.taxable,
            cgst=split.cgst,
            sgst=split.sgst,
            igst=split.igst,
            warehouse=warehouse,
            over_receipt_pct=line.get("over_receipt_pct", 0),
            requisition_line=line.get("requisition_line"),
        )
        if line.get("requisition_line") is not None:
            RequisitionLine.objects.filter(pk=line["requisition_line"].pk).update(
                ordered_quantity=line["requisition_line"].ordered_quantity + Decimal(line["quantity"])
            )
        subtotal += split.taxable
        tax += split.total_tax
    po.subtotal, po.tax_total, po.amount = subtotal, tax, subtotal + tax
    po.number = allocate_number(company.pk, "PO", order_date)
    po.save(update_fields=["subtotal", "tax_total", "amount", "number"])
    audit.record(
        f"{PO}.created",
        ctx=ctx,
        resource_type=PO,
        resource_id=po.pk,
        company_id=company.pk,
        summary=f"{po.number} {supplier.name} {po.amount}",
    )
    return po


def submit_order(ctx, po, expected_version=None):
    return workflow.submit(
        ctx,
        po,
        document_type=PO,
        title=f"Purchase order to {po.supplier.name}",
        summary={"supplier": po.supplier.name, "expected": str(po.expected_date)},
        scope={"branch_id": po.branch_id},
        expected_version=expected_version,
    )


@transaction.atomic
def cancel_requisition(ctx: ActorContext, pr: PurchaseRequisition, reason: str) -> PurchaseRequisition:
    pr = PurchaseRequisition.objects.select_for_update().get(pk=pr.pk)
    pdp.require(ctx, f"{PR}.cancel", pdp.Resource.of(pr))
    if pr.status in ("cancelled", "closed"):
        raise InvalidStateTransition("This requisition is already closed.")
    if pr.status == "submitted":
        raise InvalidStateTransition("Withdraw it from its approval first.")
    if pr.rfqs.exists() or PurchaseOrder.objects.filter(requisition=pr).exclude(status="cancelled").exists():
        raise InvalidStateTransition("RFQs or orders were raised from this requisition; cancel those instead.")
    if not reason.strip():
        raise ValidationError({"reason": ["Give the reason for cancelling."]})
    workflow.bump(pr, ctx, status="cancelled")
    audit.record(
        f"{PR}.cancelled", ctx=ctx, resource_type=PR, resource_id=pr.pk, company_id=pr.company_id, summary=reason[:500]
    )
    return pr


@transaction.atomic
def cancel_order(ctx: ActorContext, po: PurchaseOrder, reason: str) -> PurchaseOrder:
    po = PurchaseOrder.objects.select_for_update().get(pk=po.pk)
    pdp.require(ctx, f"{PO}.cancel", pdp.Resource.of(po))
    if po.status in ("cancelled", "closed") or po.lines.filter(received_quantity__gt=0).exists():
        raise InvalidStateTransition("Orders with receipts can't be cancelled; close the remainder instead.")
    workflow.bump(po, ctx, status="cancelled")
    audit.record(
        f"{PO}.cancelled", ctx=ctx, resource_type=PO, resource_id=po.pk, company_id=po.company_id, summary=reason
    )
    return po


workflow.register(PR, PurchaseRequisition, "Purchase requisition", "/procurement/requisitions")
workflow.register(PO, PurchaseOrder, "Purchase order", "/procurement/orders")


# --- Goods receipt -----------------------------------------------------------------------------------


@transaction.atomic
def create_receipt(
    ctx: ActorContext,
    *,
    order: PurchaseOrder,
    warehouse,
    receipt_date: date,
    lines: list[dict],
    supplier_delivery_note: str = "",
    vehicle_number: str = "",
) -> GoodsReceipt:
    pdp.require(ctx, f"{GRN}.create", pdp.Resource.ref(GRN, company_id=order.company_id, warehouse_id=warehouse.pk))
    if order.status != "approved":
        raise BusinessRuleViolation("Only approved purchase orders can be received.", code="po_not_approved")
    if not lines:
        raise ValidationError({"lines": ["Add at least one line."]})
    grn = GoodsReceipt.objects.create(
        company_id=order.company_id,
        purchase_order=order,
        supplier=order.supplier,
        warehouse=warehouse,
        receipt_date=receipt_date,
        supplier_delivery_note=supplier_delivery_note,
        vehicle_number=vehicle_number,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for line in lines:
        if line["po_line"].order_id != order.pk:
            raise ValidationError({"lines": ["Line belongs to another order."]})
        # Early check so an impossible receipt isn't left behind as a draft; posting re-checks under lock.
        _check_over_receipt(line["po_line"], line["quantity"])
        GoodsReceiptLine.objects.create(receipt=grn, **line)
    return grn


def _check_over_receipt(po_line: PurchaseOrderLine, quantity) -> None:
    limit = po_line.quantity * (1 + po_line.over_receipt_pct / 100)
    if po_line.received_quantity + quantity > limit:
        remaining = (limit - po_line.received_quantity).normalize()
        raise BusinessRuleViolation(
            f"{po_line.item.code}: receipt exceeds the order (open {remaining}).",
            code="over_receipt",
            meta={"line": str(po_line.pk), "open": str(remaining)},
        )


@transaction.atomic
def post_receipt(ctx: ActorContext, grn: GoodsReceipt, expected_version=None) -> GoodsReceipt:
    grn = GoodsReceipt.objects.select_for_update(of=("self",)).select_related("warehouse", "supplier").get(pk=grn.pk)
    workflow.check(grn, expected_version, "draft")
    pdp.require(ctx, f"{GRN}.post", pdp.Resource.of(grn))
    moves, qc_lines = [], []
    for line in grn.lines.select_related("po_line__item__category", "po_line__item__stock_uom", "po_line__uom"):
        po_line = PurchaseOrderLine.objects.select_for_update().get(pk=line.po_line_id)
        _check_over_receipt(po_line, line.quantity)  # authoritative: under lock, at posting
        item = po_line.item
        net_rate = po_line.rate * (1 - po_line.discount_pct / 100)
        line.stock_quantity = to_stock_qty(item, line.quantity, po_line.uom)
        line.unit_cost = stock_rate(item, net_rate, po_line.uom)
        line.save(update_fields=["stock_quantity", "unit_cost"])
        batch = get_or_create_batch(
            grn.company_id,
            item,
            line.batch_number,
            expires_on=line.expires_on,
            manufactured_on=line.manufactured_on,
            supplier_batch=line.batch_number,
        )
        hold = item.inspection_required
        grni_value = (line.quantity * net_rate).quantize(Q2, rounding=ROUND_HALF_UP)
        moves.append(
            Move(
                item=item,
                warehouse=grn.warehouse,
                quantity=line.stock_quantity,
                movement_type="receipt",
                stock_status=StockStatus.QUALITY_HOLD if hold else StockStatus.UNRESTRICTED,
                location=line.location,
                batch=batch,
                serials=list(line.serials),
                unit_cost=(grni_value / line.stock_quantity),
                contra_key="grni",
                partner_id=grn.supplier_id,
                source_line_id=line.pk,
            )
        )
        if hold:
            qc_lines.append((line, batch))
        po_line.received_quantity += line.quantity
        po_line.save(update_fields=["received_quantity"])
    grn.number = allocate_number(grn.company_id, "GRN", grn.receipt_date)
    grn.stock_transaction = post_stock(
        ctx,
        company_id=grn.company_id,
        posting_date=grn.receipt_date,
        moves=moves,
        source_type=GRN,
        source_id=grn.pk,
        reference=grn.number,
        narration=f"Goods receipt {grn.number} from {grn.supplier.name}",
    )
    for line, batch in qc_lines:
        line.inspection = quality.create_inspection(
            ctx,
            company_id=grn.company_id,
            stage="receipt",
            item=line.po_line.item,
            warehouse=grn.warehouse,
            quantity=line.stock_quantity,
            source_type=GRN,
            source_id=grn.pk,
            source_line_id=line.pk,
            batch=batch,
            serials=list(line.serials),
            supplier=grn.supplier,
            on=grn.receipt_date,
        )
        line.save(update_fields=["inspection"])
    workflow.bump(grn, ctx, status="posted", posted_by=ctx.user)
    _refresh_receipt_status(grn.purchase_order_id)
    audit.record(
        f"{GRN}.posted", ctx=ctx, resource_type=GRN, resource_id=grn.pk, company_id=grn.company_id, summary=grn.number
    )
    publish_event(
        "procurement.goods_receipt.posted", aggregate_type=GRN, aggregate_id=grn.pk, company_id=grn.company_id
    )
    return grn


def _refresh_receipt_status(order_id) -> None:
    order = PurchaseOrder.objects.select_for_update().get(pk=order_id)
    lines = list(order.lines.all())
    net = [line.received_quantity - line.returned_quantity for line in lines]
    if all(n >= line.quantity for n, line in zip(net, lines, strict=True)):
        status = "received"
    elif any(line.received_quantity > 0 for line in lines):
        status = "partially_received"
    else:
        status = "open"
    if status != order.receipt_status:
        PurchaseOrder.objects.filter(pk=order.pk).update(receipt_status=status)


# --- Purchase returns ---------------------------------------------------------------------------------


@transaction.atomic
def create_return(
    ctx: ActorContext, *, receipt: GoodsReceipt, return_date: date, reason: str, lines: list[dict]
) -> PurchaseReturn:
    pdp.require(ctx, "procurement.purchase_return.create", pdp.Resource.of(receipt))
    if receipt.status != "posted":
        raise BusinessRuleViolation("Only posted receipts can be returned against.", code="grn_not_posted")
    ret = PurchaseReturn.objects.create(
        company_id=receipt.company_id,
        receipt=receipt,
        supplier=receipt.supplier,
        warehouse=receipt.warehouse,
        return_date=return_date,
        reason=reason,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for line in lines:
        if line["receipt_line"].receipt_id != receipt.pk:
            raise ValidationError({"lines": ["Line belongs to another receipt."]})
        PurchaseReturnLine.objects.create(purchase_return=ret, **line)
    return ret


@transaction.atomic
def post_return(ctx: ActorContext, ret: PurchaseReturn, expected_version=None) -> PurchaseReturn:
    ret = PurchaseReturn.objects.select_for_update(of=("self",)).select_related("warehouse", "supplier").get(pk=ret.pk)
    workflow.check(ret, expected_version, "draft")
    pdp.require(ctx, "procurement.purchase_return.post", pdp.Resource.of(ret))
    moves = []
    for line in ret.lines.select_related("receipt_line__po_line__item__category", "receipt_line__po_line__uom"):
        grn_line = GoodsReceiptLine.objects.select_for_update().get(pk=line.receipt_line_id)
        po_line = PurchaseOrderLine.objects.select_for_update().get(pk=grn_line.po_line_id)
        already = sum((r.quantity for r in grn_line.return_lines.filter(purchase_return__status="posted")), Decimal(0))
        if already + line.quantity > grn_line.quantity:
            raise BusinessRuleViolation("Return exceeds the quantity received.", code="over_return")
        item = po_line.item
        stock_qty = to_stock_qty(item, line.quantity, po_line.uom)
        receipt_value = (stock_qty * grn_line.unit_cost).quantize(Q2, rounding=ROUND_HALF_UP)
        batch = None
        if grn_line.batch_number:
            batch = get_or_create_batch(ret.company_id, item, grn_line.batch_number, create=False)
        moves.append(
            Move(
                item=item,
                warehouse=ret.warehouse,
                quantity=-stock_qty,
                movement_type="purchase_return",
                stock_status=line.from_status,
                batch=batch,
                allow_expired=True,
                contra_key="grni",
                contra_amount=receipt_value,
                variance_key="purchase_price_variance",
                partner_id=ret.supplier_id,
                source_line_id=line.pk,
            )
        )
        po_line.returned_quantity += line.quantity
        po_line.save(update_fields=["returned_quantity"])
    ret.number = allocate_number(ret.company_id, "PRN", ret.return_date)
    ret.stock_transaction = post_stock(
        ctx,
        company_id=ret.company_id,
        posting_date=ret.return_date,
        moves=moves,
        source_type="procurement.purchase_return",
        source_id=ret.pk,
        reference=ret.number,
        narration=f"Return {ret.number} to {ret.supplier.name}",
    )
    workflow.bump(ret, ctx, status="posted")
    _refresh_receipt_status(ret.receipt.purchase_order_id)
    publish_event(
        "procurement.purchase_return.posted",
        aggregate_type="procurement.purchase_return",
        aggregate_id=ret.pk,
        company_id=ret.company_id,
    )
    return ret
