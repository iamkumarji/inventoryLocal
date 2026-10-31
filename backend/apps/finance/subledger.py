"""Accounts payable, receivable, payments, banking, budgets and period close (SRS §3.12)."""

from __future__ import annotations

import csv
import io
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import transaction
from django.db.models import F, Sum
from django.db.models.functions import Coalesce
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition
from apps.core.ids import uuid7
from apps.core.outbox import publish_event
from apps.organization.models import FiscalPeriod, FiscalYear
from apps.organization.services import allocate_number
from apps.shared import workflow
from apps.shared.tax import is_intra_state, line_amounts

from .models import (
    Account,
    BankAccount,
    BankStatementLine,
    Budget,
    BudgetLine,
    JournalLine,
    MatchTolerance,
    OpenItem,
    Payment,
    PaymentAllocation,
    SupplierInvoice,
    SupplierInvoiceLine,
)
from .posting import Line, post_journal, resolve_account

Q2 = Decimal("0.01")
ZERO = Decimal("0")
AP_INVOICE = "finance.supplier_invoice"
PAYMENT = "finance.payment"


# --- Open items ----------------------------------------------------------------------------------


def create_open_item(
    *, company_id, partner_id, kind, document_type, document_id, number, document_date, due_date, amount
) -> OpenItem:
    return OpenItem.objects.create(
        company_id=company_id,
        partner_id=partner_id,
        kind=kind,
        document_type=document_type,
        document_id=document_id,
        number=number,
        document_date=document_date,
        due_date=due_date,
        amount=amount,
    )


def settle(item: OpenItem, amount: Decimal) -> OpenItem:
    item = OpenItem.objects.select_for_update().get(pk=item.pk)
    new_settled = item.settled + amount
    if (item.amount > 0 and not ZERO <= new_settled <= item.amount) or (
        item.amount < 0 and not item.amount <= new_settled <= ZERO
    ):
        raise BusinessRuleViolation(
            f"{item.number}: allocation exceeds the outstanding amount ({item.outstanding}).", code="over_allocation"
        )
    item.settled = new_settled
    item.is_open = item.settled != item.amount
    item.save(update_fields=["settled", "is_open"])
    return item


def ageing(company_id, kind: str, as_of: date) -> list[dict]:
    buckets = [(0, "Not due"), (30, "1–30"), (60, "31–60"), (90, "61–90"), (None, "Over 90")]
    rows: dict = {}
    for item in OpenItem.objects.filter(
        company_id=company_id, kind=kind, is_open=True, document_date__lte=as_of
    ).select_related("partner"):
        overdue = (as_of - item.due_date).days
        label = next(lbl for limit, lbl in buckets if limit is None or overdue <= limit)
        row = rows.setdefault(
            item.partner_id,
            {
                "partner_id": str(item.partner_id),
                "partner": item.partner.name,
                "total": ZERO,
                **{lbl: ZERO for _, lbl in buckets},
            },
        )
        row[label] += item.outstanding
        row["total"] += item.outstanding
    return sorted(rows.values(), key=lambda r: -r["total"])


def partner_exposure(company_id, partner_id, kind: str = "receivable") -> Decimal:
    agg = OpenItem.objects.filter(company_id=company_id, partner_id=partner_id, kind=kind, is_open=True).aggregate(
        total=Coalesce(Sum(F("amount") - F("settled")), ZERO)
    )
    return agg["total"]


def overdue_days(company_id, partner_id, as_of: date, kind: str = "receivable") -> int:
    oldest = (
        OpenItem.objects.filter(company_id=company_id, partner_id=partner_id, kind=kind, is_open=True, amount__gt=0)
        .order_by("due_date")
        .first()
    )
    return max((as_of - oldest.due_date).days, 0) if oldest else 0


# --- Supplier invoices (3-way match) ---------------------------------------------------------------


def _tolerance(company_id, supplier_id) -> MatchTolerance | None:
    return (
        MatchTolerance.objects.filter(company_id=company_id, supplier_id=supplier_id).first()
        or MatchTolerance.objects.filter(company_id=company_id, supplier__isnull=True).first()
    )


@transaction.atomic
def create_supplier_invoice(
    ctx: ActorContext,
    *,
    company,
    supplier,
    supplier_invoice_number: str,
    invoice_date: date,
    lines: list[dict],
    purchase_order=None,
) -> SupplierInvoice:
    """lines: [{grn_line | po_line, quantity, rate}] — rates and quantities as billed by the supplier."""
    pdp.require(ctx, f"{AP_INVOICE}.create", pdp.Resource.ref(AP_INVOICE, company_id=company.pk))
    if (
        SupplierInvoice.objects.filter(
            company=company, supplier=supplier, supplier_invoice_number=supplier_invoice_number
        )
        .exclude(status="cancelled")
        .exists()
    ):
        raise ValidationError({"supplier_invoice_number": ["This supplier invoice is already recorded."]})
    intra = is_intra_state(company.state_code, supplier.state_code)
    inv = SupplierInvoice.objects.create(
        company=company,
        supplier=supplier,
        invoice_date=invoice_date,
        supplier_invoice_number=supplier_invoice_number,
        purchase_order=purchase_order,
        intra_state=intra,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    totals = {"subtotal": ZERO, "cgst": ZERO, "sgst": ZERO, "igst": ZERO}
    for line in lines:
        grn_line = line.get("grn_line")
        po_line = grn_line.po_line if grn_line is not None else line["po_line"]
        if po_line.order.supplier_id != supplier.pk:
            raise ValidationError({"lines": ["Line belongs to another supplier's order."]})
        split = line_amounts(line["quantity"], line["rate"], po_line.discount_pct, po_line.gst_rate, intra_state=intra)
        SupplierInvoiceLine.objects.create(
            invoice=inv,
            grn_line=grn_line,
            po_line=po_line,
            quantity=line["quantity"],
            rate=line["rate"],
            gst_rate=po_line.gst_rate,
            taxable_amount=split.taxable,
            cgst=split.cgst,
            sgst=split.sgst,
            igst=split.igst,
        )
        totals["subtotal"] += split.taxable
        totals["cgst"] += split.cgst
        totals["sgst"] += split.sgst
        totals["igst"] += split.igst
    for key, value in totals.items():
        setattr(inv, key, value)
    inv.amount = sum(totals.values(), ZERO)
    terms = (
        getattr(supplier.supplier_profile, "payment_terms_days", 30) if hasattr(supplier, "supplier_profile") else 30
    )
    inv.due_date = invoice_date + timedelta(days=terms)
    inv.save()
    return inv


def match(inv: SupplierInvoice) -> tuple[str, list[dict]]:
    """Quantity: billed ≤ received − already invoiced. Price: within tolerance of the PO rate."""
    tol = _tolerance(inv.company_id, inv.supplier_id)
    price_pct, price_abs = (tol.price_pct, tol.price_abs) if tol else (Decimal("0"), Decimal("0"))
    notes = []
    for line in inv.lines.select_related("grn_line", "po_line__item"):
        code = line.po_line.item.code
        if line.grn_line is not None:
            open_qty = line.grn_line.quantity - line.grn_line.invoiced_quantity
            if line.quantity > open_qty:
                notes.append(
                    {"item": code, "issue": "quantity", "billed": str(line.quantity), "received_open": str(open_qty)}
                )
        elif line.po_line.item.is_stocked:
            notes.append({"item": code, "issue": "no_receipt", "detail": "Stocked items are invoiced against a GRN."})
        else:
            open_qty = line.po_line.quantity - line.po_line.invoiced_quantity
            if line.quantity > open_qty:
                notes.append(
                    {"item": code, "issue": "quantity", "billed": str(line.quantity), "ordered_open": str(open_qty)}
                )
        diff = (line.rate - line.po_line.rate) * line.quantity
        allowed = max(line.po_line.rate * line.quantity * price_pct / 100, price_abs)
        if abs(diff) > allowed:
            notes.append(
                {
                    "item": code,
                    "issue": "price",
                    "po_rate": str(line.po_line.rate),
                    "billed_rate": str(line.rate),
                    "difference": str(diff.quantize(Q2)),
                }
            )
    blocking = [n for n in notes if n["issue"] in ("quantity", "no_receipt")]
    if blocking:
        raise BusinessRuleViolation(
            "The invoice doesn't match what was received.", code="match_failed", meta={"issues": blocking}
        )
    return ("variance" if notes else "matched"), notes


@transaction.atomic
def submit_supplier_invoice(ctx: ActorContext, inv: SupplierInvoice, expected_version=None) -> SupplierInvoice:
    inv = SupplierInvoice.objects.select_for_update().get(pk=inv.pk)
    workflow.check(inv, expected_version, "draft", "rejected")
    status, notes = match(inv)
    inv.match_status, inv.match_notes = status, notes
    inv.save(update_fields=["match_status", "match_notes"])
    if status == "matched":
        # A clean three-way match is itself the independent check: approve without a human step.
        pdp.require(ctx, f"{AP_INVOICE}.update", pdp.Resource.of(inv))
        return workflow.bump(inv, ctx, status="approved", submitted_by=ctx.user)
    return workflow.submit(
        ctx,
        inv,
        document_type=AP_INVOICE,
        title=f"Price variance on {inv.supplier.name} invoice {inv.supplier_invoice_number}",
        summary={"issues": len(notes)},
    )


@transaction.atomic
def post_supplier_invoice(ctx: ActorContext, inv: SupplierInvoice, expected_version=None) -> SupplierInvoice:
    from apps.inventory.models import StockLedgerEntry
    from apps.procurement.models import GoodsReceiptLine, PurchaseOrderLine

    inv = SupplierInvoice.objects.select_for_update().select_related("supplier").get(pk=inv.pk)
    workflow.check(inv, expected_version, "approved")
    pdp.require(ctx, f"{AP_INVOICE}.post", pdp.Resource.of(inv))
    lines = [Line(amount=-inv.amount, key="ap", partner_id=inv.supplier_id)]
    for key, amount in (("gst_input_cgst", inv.cgst), ("gst_input_sgst", inv.sgst), ("gst_input_igst", inv.igst)):
        lines.append(Line(amount=amount, key=key))
    for line in inv.lines.select_related("po_line__item__category", "grn_line"):
        po_line = PurchaseOrderLine.objects.select_for_update().get(pk=line.po_line_id)
        if line.grn_line_id:
            grn_line = GoodsReceiptLine.objects.select_for_update().get(pk=line.grn_line_id)
            if grn_line.invoiced_quantity + line.quantity > grn_line.quantity:
                raise BusinessRuleViolation("Receipt already invoiced.", code="already_invoiced")
            received_value = (
                StockLedgerEntry.objects.filter(source_line_id=grn_line.pk, movement_type="receipt").aggregate(
                    v=Sum("value")
                )["v"]
                or ZERO
            )
            grni = (received_value * line.quantity / grn_line.quantity).quantize(Q2, rounding=ROUND_HALF_UP)
            lines += [
                Line(amount=grni, key="grni", partner_id=inv.supplier_id, item_id=po_line.item_id),
                Line(
                    amount=line.taxable_amount - grni,
                    key="purchase_price_variance",
                    posting_group=po_line.item.category.posting_group,
                    item_id=po_line.item_id,
                ),
            ]
            grn_line.invoiced_quantity += line.quantity
            grn_line.save(update_fields=["invoiced_quantity"])
        else:  # services: expensed directly
            lines.append(Line(amount=line.taxable_amount, key="expense_default", item_id=po_line.item_id))
        po_line.invoiced_quantity += line.quantity
        po_line.save(update_fields=["invoiced_quantity"])
    inv.number = allocate_number(inv.company_id, "PI", inv.invoice_date)
    inv.journal_entry = post_journal(
        ctx,
        company_id=inv.company_id,
        entry_date=inv.invoice_date,
        lines=lines,
        narration=f"Supplier invoice {inv.supplier_invoice_number} ({inv.supplier.name})",
        source_module="finance",
        source_type=AP_INVOICE,
        source_id=inv.pk,
    )
    create_open_item(
        company_id=inv.company_id,
        partner_id=inv.supplier_id,
        kind=OpenItem.Kind.PAYABLE,
        document_type=AP_INVOICE,
        document_id=inv.pk,
        number=inv.supplier_invoice_number,
        document_date=inv.invoice_date,
        due_date=inv.due_date,
        amount=inv.amount,
    )
    workflow.bump(inv, ctx, status="posted")
    audit.record(
        f"{AP_INVOICE}.posted",
        ctx=ctx,
        resource_type=AP_INVOICE,
        resource_id=inv.pk,
        company_id=inv.company_id,
        summary=f"{inv.number} {inv.amount}",
    )
    return inv


workflow.register(AP_INVOICE, SupplierInvoice, "Supplier invoice", "/finance/supplier-invoices")


# --- Payments and receipts --------------------------------------------------------------------------


@transaction.atomic
def create_payment(
    ctx: ActorContext,
    *,
    company,
    kind: str,
    partner,
    bank_account: BankAccount,
    payment_date: date,
    mode: str,
    amount: Decimal,
    allocations: list[dict],
    reference: str = "",
) -> Payment:
    pdp.require(ctx, f"{PAYMENT}.create", pdp.Resource.ref(PAYMENT, company_id=company.pk))
    if bank_account.company_id != company.pk:
        raise ValidationError({"bank_account": ["Bank account belongs to another company."]})
    expected_kind = OpenItem.Kind.PAYABLE if kind == Payment.Kind.SUPPLIER_PAYMENT else OpenItem.Kind.RECEIVABLE
    allocated = ZERO
    for alloc in allocations:
        item = alloc["open_item"]
        if item.partner_id != partner.pk or item.kind != expected_kind or item.company_id != company.pk:
            raise ValidationError({"allocations": [f"{item.number} can't be settled by this payment."]})
        allocated += alloc["amount"]
    if allocated > amount:
        raise ValidationError({"allocations": ["Allocations exceed the payment amount."]})
    payment = Payment.objects.create(
        company=company,
        kind=kind,
        partner=partner,
        bank_account=bank_account,
        payment_date=payment_date,
        mode=mode,
        amount=amount,
        reference=reference,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    for alloc in allocations:
        PaymentAllocation.objects.create(payment=payment, open_item=alloc["open_item"], amount=alloc["amount"])
    return payment


def submit_payment(ctx: ActorContext, payment: Payment, expected_version=None) -> Payment:
    if payment.kind == Payment.Kind.CUSTOMER_RECEIPT:  # money in: no approval step
        with transaction.atomic():
            payment = Payment.objects.select_for_update().get(pk=payment.pk)
            workflow.check(payment, expected_version, "draft")
            pdp.require(ctx, f"{PAYMENT}.update", pdp.Resource.of(payment))
            return workflow.bump(payment, ctx, status="approved", submitted_by=ctx.user)
    return workflow.submit(
        ctx,
        payment,
        document_type=PAYMENT,
        title=f"Payment to {payment.partner.name}",
        summary={"mode": payment.mode},
        expected_version=expected_version,
    )


@transaction.atomic
def post_payment(ctx: ActorContext, payment: Payment, expected_version=None) -> Payment:
    from apps.partners.models import PartnerBankAccount

    payment = Payment.objects.select_for_update().select_related("bank_account__account", "partner").get(pk=payment.pk)
    workflow.check(payment, expected_version, "approved")
    pdp.require(ctx, f"{PAYMENT}.post", pdp.Resource.of(payment))
    supplier = payment.kind == Payment.Kind.SUPPLIER_PAYMENT
    if supplier and payment.created_by_id == ctx.user_id and payment.approved_by_id is None:
        raise AuthorizationDenied(reason="maker_checker")
    if supplier and payment.mode != Payment.Mode.CASH:
        verified = PartnerBankAccount.objects.filter(
            partner=payment.partner, status=PartnerBankAccount.Status.VERIFIED
        ).first()
        if verified is None:
            raise BusinessRuleViolation(
                f"{payment.partner.name} has no verified bank account.", code="bank_account_unverified"
            )
        payment.partner_bank_account = verified
    control = "ap" if supplier else "ar"
    sign = Decimal(1) if supplier else Decimal(-1)
    lines = [
        Line(amount=sign * payment.amount, key=control, partner_id=payment.partner_id),
        Line(amount=-sign * payment.amount, account=payment.bank_account.account),
    ]
    for alloc in payment.allocations.select_related("open_item"):
        settle(alloc.open_item, alloc.amount)
    unallocated = payment.amount - sum((a.amount for a in payment.allocations.all()), ZERO)
    payment.number = allocate_number(payment.company_id, "PAY" if supplier else "RCT", payment.payment_date)
    if unallocated > 0:  # advance / on-account: a negative open item settles future invoices
        payment.advance_item = create_open_item(
            company_id=payment.company_id,
            partner_id=payment.partner_id,
            kind=OpenItem.Kind.PAYABLE if supplier else OpenItem.Kind.RECEIVABLE,
            document_type=f"{PAYMENT}.advance",
            document_id=payment.pk,
            number=payment.number,
            document_date=payment.payment_date,
            due_date=payment.payment_date,
            amount=-unallocated,
        )
    payment.journal_entry = post_journal(
        ctx,
        company_id=payment.company_id,
        entry_date=payment.payment_date,
        lines=lines,
        narration=f"{payment.get_kind_display()} {payment.number}",
        source_module="finance",
        source_type=PAYMENT,
        source_id=payment.pk,
    )
    workflow.bump(payment, ctx, status="posted")
    audit.record(
        f"{PAYMENT}.posted",
        ctx=ctx,
        resource_type=PAYMENT,
        resource_id=payment.pk,
        company_id=payment.company_id,
        summary=f"{payment.number} {payment.amount}",
    )
    publish_event(
        "finance.payment.posted", aggregate_type=PAYMENT, aggregate_id=payment.pk, company_id=payment.company_id
    )
    return payment


@transaction.atomic
def apply_credit(ctx: ActorContext, *, credit: OpenItem, debit: OpenItem, amount: Decimal) -> None:
    """Offset a credit note or advance (negative item) against an invoice of the same partner."""
    pdp.require(ctx, f"{PAYMENT}.create", pdp.Resource.ref(PAYMENT, company_id=credit.company_id))
    if credit.partner_id != debit.partner_id or credit.kind != debit.kind or credit.amount >= 0 or debit.amount <= 0:
        raise ValidationError({"credit": ["Choose a credit and an invoice of the same partner."]})
    if amount <= 0:
        raise ValidationError({"amount": ["Enter a positive amount."]})
    settle(credit, -amount)
    settle(debit, amount)
    audit.record(
        "finance.open_item.credit_applied",
        ctx=ctx,
        resource_type="finance.open_item",
        resource_id=debit.pk,
        company_id=debit.company_id,
        summary=f"{credit.number} applied to {debit.number}: {amount}",
    )


workflow.register(PAYMENT, Payment, "Supplier payment", "/finance/payments")


# --- Bank reconciliation --------------------------------------------------------------------------


@transaction.atomic
def import_statement(ctx: ActorContext, bank_account: BankAccount, csv_text: str) -> dict:
    """CSV columns: date (YYYY-MM-DD), description, reference, debit, credit, balance. All or nothing."""
    pdp.require(ctx, "finance.bank_account.update", pdp.Resource.of(bank_account))
    reader = csv.DictReader(io.StringIO(csv_text))
    required = {"date", "description", "reference", "debit", "credit", "balance"}
    if not reader.fieldnames or not required <= {f.strip().lower() for f in reader.fieldnames}:
        raise ValidationError({"file": [f"Columns needed: {', '.join(sorted(required))}."]})
    batch, rows, errors = uuid7(), [], []
    for n, raw in enumerate(reader, start=2):
        row = {k.strip().lower(): (v or "").strip() for k, v in raw.items()}
        try:
            debit = Decimal(row["debit"] or "0")
            credit = Decimal(row["credit"] or "0")
            rows.append(
                BankStatementLine(
                    company_id=bank_account.company_id,
                    bank_account=bank_account,
                    import_batch=batch,
                    txn_date=date.fromisoformat(row["date"]),
                    description=row["description"][:300],
                    reference=row["reference"][:100],
                    amount=credit - debit,
                    balance=Decimal(row["balance"]) if row["balance"] else None,
                    created_by=ctx.user,
                    updated_by=ctx.user,
                )
            )
        except (ValueError, InvalidOperation):
            errors.append({"row": n, "message": "Unreadable date or amount."})
    if rows and not errors:
        # A line already imported (same date, amount, reference and running balance) means an overlapping file.
        def key(line):
            return (line.txn_date, line.amount, line.reference, line.balance, line.description)

        existing = {
            key(line)
            for line in BankStatementLine.objects.filter(
                bank_account=bank_account,
                txn_date__gte=min(r.txn_date for r in rows),
                txn_date__lte=max(r.txn_date for r in rows),
            )
        }
        errors = [{"row": n, "message": "Already imported."} for n, r in enumerate(rows, start=2) if key(r) in existing]
    if errors:
        raise ValidationError({"file": [f"Row {e['row']}: {e['message']}" for e in errors[:20]]})
    BankStatementLine.objects.bulk_create(rows)
    matched = auto_match(ctx, bank_account)
    return {"imported": len(rows), "auto_matched": matched, "batch": str(batch)}


def _unreconciled_book_lines(bank_account: BankAccount):
    return JournalLine.objects.filter(
        account=bank_account.account, entry__status="posted", statement_line__isnull=True
    ).select_related("entry")


def auto_match(ctx: ActorContext, bank_account: BankAccount, window_days: int = 5) -> int:
    matched = 0
    for st in BankStatementLine.objects.filter(bank_account=bank_account, status="unmatched").order_by("txn_date"):
        book = _unreconciled_book_lines(bank_account).filter(
            entry__entry_date__gte=st.txn_date - timedelta(days=window_days),
            entry__entry_date__lte=st.txn_date + timedelta(days=window_days),
        )
        book = book.filter(debit=st.amount) if st.amount > 0 else book.filter(credit=-st.amount)
        candidates = list(book)
        pick = next(
            (c for c in candidates if st.reference and st.reference in (c.entry.narration + c.description)),
            candidates[0] if len(candidates) == 1 else None,
        )
        if pick is not None:
            st.status, st.matched_line, st.matched_by = "matched", pick, ctx.user
            st.save(update_fields=["status", "matched_line", "matched_by", "updated_at"])
            matched += 1
    return matched


@transaction.atomic
def manual_match(ctx: ActorContext, line: BankStatementLine, journal_line: JournalLine) -> BankStatementLine:
    line = BankStatementLine.objects.select_for_update().get(pk=line.pk)
    pdp.require(ctx, "finance.bank_account.update", pdp.Resource.of(line.bank_account))
    if line.status != "unmatched":
        raise InvalidStateTransition("Statement line is already reconciled.")
    if journal_line.account_id != line.bank_account.account_id:
        raise ValidationError({"journal_line": ["That entry isn't on this bank account."]})
    if (journal_line.debit - journal_line.credit) != line.amount:
        raise ValidationError({"journal_line": ["Amounts differ."]})
    line.status, line.matched_line, line.matched_by = "matched", journal_line, ctx.user
    line.save(update_fields=["status", "matched_line", "matched_by", "updated_at"])
    return line


def reconciliation(bank_account: BankAccount, as_of: date) -> dict:
    book = JournalLine.objects.filter(
        account=bank_account.account, entry__status="posted", entry__entry_date__lte=as_of
    ).aggregate(b=Coalesce(Sum(F("debit") - F("credit")), ZERO))["b"]
    last = (
        BankStatementLine.objects.filter(bank_account=bank_account, txn_date__lte=as_of, balance__isnull=False)
        .order_by("-txn_date", "-created_at")
        .first()
    )
    unpresented = _unreconciled_book_lines(bank_account).filter(entry__entry_date__lte=as_of)
    return {
        "book_balance": book,
        "statement_balance": last.balance if last else None,
        "unreconciled_book_items": [
            {
                "id": str(j.pk),
                "date": j.entry.entry_date,
                "number": j.entry.number,
                "amount": j.debit - j.credit,
                "narration": j.entry.narration,
            }
            for j in unpresented
        ],
        "unmatched_statement_lines": BankStatementLine.objects.filter(
            bank_account=bank_account, status="unmatched", txn_date__lte=as_of
        ).count(),
    }


# --- Budgets ----------------------------------------------------------------------------------------


BUDGET = "finance.budget"


def _budget_lines(budget: Budget, lines: list[dict]) -> None:
    fy = budget.fiscal_year
    periods = fy.periods.count()
    seen = set()
    for line in lines:
        account, cost_center = line["account"], line.get("cost_center")
        if account.company_id != budget.company_id or account.is_group:
            raise ValidationError({"lines": [f"{account.code}: choose a posting account of this company."]})
        if cost_center is not None and cost_center.company_id != budget.company_id:
            raise ValidationError({"lines": ["Cost centre belongs to another company."]})
        if not 1 <= line["period_no"] <= periods:
            raise ValidationError({"lines": [f"Period must be between 1 and {periods}."]})
        key = (account.pk, getattr(cost_center, "pk", None), line["period_no"])
        if key in seen:
            raise ValidationError({"lines": [f"{account.code} period {line['period_no']} appears twice."]})
        seen.add(key)
        BudgetLine.objects.create(
            budget=budget, account=account, cost_center=cost_center, period_no=line["period_no"], amount=line["amount"]
        )


@transaction.atomic
def create_budget(ctx: ActorContext, *, company, fiscal_year, name: str, lines: list[dict]) -> Budget:
    pdp.require(ctx, f"{BUDGET}.create", pdp.Resource.ref(BUDGET, company_id=company.pk))
    if fiscal_year.company_id != company.pk:
        raise ValidationError({"fiscal_year": ["Fiscal year belongs to another company."]})
    budget = Budget.objects.create(
        company=company, fiscal_year=fiscal_year, name=name, created_by=ctx.user, updated_by=ctx.user
    )
    _budget_lines(budget, lines)
    audit.record(
        f"{BUDGET}.created", ctx=ctx, resource_type=BUDGET, resource_id=budget.pk, company_id=company.pk, summary=name
    )
    return budget


@transaction.atomic
def update_budget(ctx: ActorContext, budget: Budget, *, name=None, lines=None, expected_version=None) -> Budget:
    budget = Budget.objects.select_for_update().select_related("fiscal_year").get(pk=budget.pk)
    workflow.check(budget, expected_version, "draft")
    pdp.require(ctx, f"{BUDGET}.update", pdp.Resource.of(budget))
    if lines is not None:
        budget.lines.all().delete()
        _budget_lines(budget, lines)
    workflow.bump(budget, ctx, **({"name": name} if name else {}))
    return budget


@transaction.atomic
def approve_budget(ctx: ActorContext, budget: Budget, expected_version=None) -> Budget:
    """Approved budgets drive variance reporting; whoever prepared one can't approve it."""
    budget = Budget.objects.select_for_update().get(pk=budget.pk)
    workflow.check(budget, expected_version, "draft")
    pdp.require(ctx, f"{BUDGET}.approve", pdp.Resource.of(budget))
    if budget.created_by_id == ctx.user_id:
        raise AuthorizationDenied(reason="maker_checker")
    if not budget.lines.exists():
        raise ValidationError({"lines": ["Add budget lines before approving."]})
    workflow.bump(budget, ctx, status="approved")
    audit.record(
        f"{BUDGET}.approved",
        ctx=ctx,
        resource_type=BUDGET,
        resource_id=budget.pk,
        company_id=budget.company_id,
        summary=budget.name,
    )
    return budget


def budget_vs_actual(budget) -> list[dict]:
    fy = budget.fiscal_year
    rows = []
    agg = (
        BudgetLine.objects.filter(budget=budget)
        .values("account_id", "account__code", "account__name", "cost_center_id")
        .annotate(planned=Sum("amount"))
    )
    for row in agg:
        actual_q = JournalLine.objects.filter(
            entry__company_id=budget.company_id,
            entry__status="posted",
            account_id=row["account_id"],
            entry__entry_date__gte=fy.start_date,
            entry__entry_date__lte=fy.end_date,
        )
        if row["cost_center_id"]:
            actual_q = actual_q.filter(cost_center_id=row["cost_center_id"])
        actual = actual_q.aggregate(a=Coalesce(Sum(F("debit") - F("credit")), ZERO))["a"]
        rows.append(
            {
                "account": row["account__code"],
                "name": row["account__name"],
                "cost_center_id": str(row["cost_center_id"]) if row["cost_center_id"] else None,
                "planned": row["planned"],
                "actual": actual,
                "variance": row["planned"] - actual,
            }
        )
    return rows


# --- Period close ------------------------------------------------------------------------------------


def subledger_reconciliation(company_id, as_of: date) -> list[dict]:
    """Inventory, AP and AR sub-ledgers must equal their GL control accounts."""
    from apps.inventory.models import StockLedgerEntry

    checks = []

    def gl(account_ids):
        return JournalLine.objects.filter(
            entry__company_id=company_id,
            entry__status="posted",
            entry__entry_date__lte=as_of,
            account_id__in=account_ids,
        ).aggregate(b=Coalesce(Sum(F("debit") - F("credit")), ZERO))["b"]

    inventory_accounts = Account.objects.filter(company_id=company_id, sub_type="inventory").values_list(
        "id", flat=True
    )
    # Every figure is as of the date, so earlier periods can be reconciled after later activity.
    stock_value = StockLedgerEntry.objects.filter(company_id=company_id, posting_date__lte=as_of).aggregate(
        v=Coalesce(Sum("value"), ZERO)
    )["v"]
    checks.append({"check": "inventory", "subledger": stock_value, "gl": gl(inventory_accounts)})
    for kind, key in (("receivable", "ar"), ("payable", "ap")):
        raised = OpenItem.objects.filter(company_id=company_id, kind=kind, document_date__lte=as_of).aggregate(
            v=Coalesce(Sum("amount"), ZERO)
        )["v"]
        # Payment allocations reduce the total; credit offsets (apply_credit) settle both sides and net to zero.
        paid = PaymentAllocation.objects.filter(
            open_item__company_id=company_id,
            open_item__kind=kind,
            payment__status="posted",
            payment__payment_date__lte=as_of,
        ).aggregate(v=Coalesce(Sum("amount"), ZERO))["v"]
        sub = raised - paid
        account = resolve_account(company_id, key)
        balance = gl([account.pk])
        checks.append({"check": kind, "subledger": sub, "gl": balance if kind == "receivable" else -balance})
    for c in checks:
        c["difference"] = c["subledger"] - c["gl"]
        c["ok"] = c["difference"] == 0
    return checks


@transaction.atomic
def close_period(ctx: ActorContext, period: FiscalPeriod, *, force: bool = False) -> dict:
    period = FiscalPeriod.objects.select_for_update().select_related("fiscal_year").get(pk=period.pk)
    company_id = period.fiscal_year.company_id
    pdp.require(ctx, "finance.period.manage", pdp.Resource.ref("finance.period", company_id=company_id))
    if period.status == FiscalPeriod.Status.CLOSED:
        raise InvalidStateTransition("The period is already closed.")
    earlier_open = FiscalPeriod.objects.filter(
        fiscal_year__company_id=company_id, end_date__lt=period.start_date, status=FiscalPeriod.Status.OPEN
    ).exists()
    if earlier_open:
        raise BusinessRuleViolation("Close earlier periods first.", code="earlier_period_open")
    checks = subledger_reconciliation(company_id, period.end_date)
    if not all(c["ok"] for c in checks) and not force:
        raise BusinessRuleViolation(
            "Sub-ledgers don't agree with the general ledger.",
            code="reconciliation_failed",
            meta={
                "checks": [
                    {**c, "subledger": str(c["subledger"]), "gl": str(c["gl"]), "difference": str(c["difference"])}
                    for c in checks
                ]
            },
        )
    period.status = FiscalPeriod.Status.CLOSED
    period.inventory_locked = period.ap_locked = period.ar_locked = period.gl_locked = True
    period.save()
    audit.record(
        "finance.period.closed",
        ctx=ctx,
        resource_type="finance.period",
        resource_id=period.pk,
        company_id=company_id,
        summary=f"{period.fiscal_year.code} P{period.period_no}",
        changes={"forced": force, "checks": [{"check": c["check"], "ok": c["ok"]} for c in checks]},
    )
    return {"period": str(period.pk), "checks": checks}


@transaction.atomic
def close_fiscal_year(ctx: ActorContext, fiscal_year: FiscalYear) -> dict:
    """Move the year's income and expense into retained earnings with a closing entry dated the last day."""
    fy = FiscalYear.objects.select_for_update().get(pk=fiscal_year.pk)
    pdp.require(ctx, "finance.period.manage", pdp.Resource.ref("finance.period", company_id=fy.company_id))
    if fy.status == FiscalYear.Status.CLOSED:
        raise InvalidStateTransition("The year is already closed.")
    open_periods = fy.periods.exclude(period_no=12).filter(status=FiscalPeriod.Status.OPEN).count()
    if open_periods:
        raise BusinessRuleViolation("Close periods 1–11 before closing the year.", code="periods_open")
    rows = (
        JournalLine.objects.filter(
            entry__company_id=fy.company_id,
            entry__status="posted",
            entry__entry_date__gte=fy.start_date,
            entry__entry_date__lte=fy.end_date,
            account__account_type__in=["income", "expense"],
        )
        .values("account_id")
        .annotate(net=Sum(F("debit") - F("credit")))
    )
    lines, profit = [], ZERO
    for row in rows:
        if row["net"]:
            lines.append(Line(amount=-row["net"], account=Account.objects.get(pk=row["account_id"])))
            profit -= row["net"]
    if lines:
        lines.append(Line(amount=-profit, key="retained_earnings"))
    entry = (
        post_journal(
            ctx,
            company_id=fy.company_id,
            entry_date=fy.end_date,
            lines=lines,
            narration=f"Year-end closing {fy.code}",
            source_module="finance",
            source_type="finance.year_end",
            source_id=fy.pk,
        )
        if lines
        else None
    )
    last = fy.periods.get(period_no=12)
    if last.status != FiscalPeriod.Status.CLOSED:
        close_period(ctx, last, force=False)
    fy.status = FiscalYear.Status.CLOSED
    fy.save(update_fields=["status", "updated_at"])
    return {"closing_entry": str(entry.pk) if entry else None, "profit": profit}
