from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.authorization.models import ApprovalLimit
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition
from apps.core.models import FeatureFlag
from apps.finance import subledger
from apps.finance.models import Account, BankAccount, BankStatementLine, MatchTolerance, OpenItem
from apps.masterdata.models import HsnCode
from apps.partners.models import Partner, PartnerBankAccount, SupplierProfile
from apps.partners.services import add_bank_account, approve_supplier, review_bank_account
from apps.procurement import mrp
from apps.procurement import services as procurement
from apps.shared import workflow
from conftest import gl_balance

pytestmark = [pytest.mark.django_db, pytest.mark.req("PRC-008")]
D = Decimal
TODAY = timezone.localdate


@pytest.fixture(autouse=True)
def modules(db):
    for key in ("module.procurement", "module.inventory", "module.finance", "module.partners"):
        FeatureFlag.objects.create(key=key, enabled_default=True)


@pytest.fixture
def p2p(org, books, plant, make_item, make_user, grant, make_role, ctx, uoms):
    books.state_code = "27"
    books.save()
    buyer, head, clerk, controller, keeper = (make_user() for _ in range(5))
    grant(buyer, ["procurement.purchase_order.create", "procurement.purchase_order.update"], plant["branch"])
    head_role = make_role(
        ["procurement.purchase_order.approve", "partners.supplier.approve", "partners.bank_account.approve"]
    )
    grant(head, [], books, role=head_role)
    grant(
        clerk,
        [
            "finance.supplier_invoice.create",
            "finance.supplier_invoice.update",
            "finance.supplier_invoice.post",
            "finance.payment.create",
            "finance.payment.update",
            "finance.payment.post",
            "partners.bank_account.update",
            "finance.bank_account.update",
        ],
        books,
    )
    controller_role = make_role(
        ["finance.supplier_invoice.approve", "finance.payment.approve", "finance.payment.post", "finance.period.manage"]
    )
    grant(controller, [], books, role=controller_role)
    grant(keeper, ["procurement.goods_receipt.create", "procurement.goods_receipt.post"], plant["rm"])
    for role, doc in (
        (head_role, "procurement.purchase_order"),
        (controller_role, "finance.supplier_invoice"),
        (controller_role, "finance.payment"),
    ):
        ApprovalLimit.objects.create(
            organization=org, role=role, document_type=doc, currency="INR", max_amount=D("5000000")
        )
    supplier = Partner.objects.create(
        organization=org,
        code="SUP9",
        name="Kolhapur Castings",
        is_supplier=True,
        gstin="27AAPFU0939F1ZV",
        state_code="27",
        created_by=buyer,
    )
    SupplierProfile.objects.create(organization=org, partner=supplier, payment_terms_days=45)
    approve_supplier(ctx(head), supplier)
    hsn = HsnCode.objects.create(organization=org, code="7325", description="Castings", gst_rate=D("18"))
    item = make_item("CASTING", hsn=hsn, uom="nos")
    po = procurement.create_order(
        ctx(buyer),
        company=books,
        branch=plant["branch"],
        supplier=supplier,
        order_date=TODAY(),
        expected_date=TODAY(),
        lines=[{"item": item, "quantity": D("100"), "uom": uoms["nos"], "rate": D("250"), "warehouse": plant["rm"]}],
    )
    procurement.submit_order(ctx(buyer), po)
    po = workflow.decide_directly(ctx(head), po, document_type=procurement.PO, approve=True)
    grn = procurement.post_receipt(
        ctx(keeper),
        procurement.create_receipt(
            ctx(keeper),
            order=po,
            warehouse=plant["rm"],
            receipt_date=TODAY(),
            lines=[{"po_line": po.lines.get(), "quantity": D("100")}],
        ),
    )
    bank = BankAccount.objects.create(
        company=books, account=Account.objects.get(company=books, code="1110"), bank_name="HDFC"
    )
    return {
        "supplier": supplier,
        "item": item,
        "po": po,
        "grn": grn,
        "bank": bank,
        "clerk": clerk,
        "controller": controller,
        "head": head,
        "buyer": buyer,
    }


def invoice(ctx, p2p, books, rate="250", qty="100", number="KC/1001"):
    return subledger.create_supplier_invoice(
        ctx(p2p["clerk"]),
        company=books,
        supplier=p2p["supplier"],
        supplier_invoice_number=number,
        invoice_date=TODAY(),
        lines=[{"grn_line": p2p["grn"].lines.get(), "quantity": D(qty), "rate": D(rate)}],
    )


@pytest.mark.req("PRC-008")
def test_three_way_match_clean_invoice_posts_and_clears_grni(ctx, p2p, books):
    inv = subledger.submit_supplier_invoice(ctx(p2p["clerk"]), invoice(ctx, p2p, books))
    assert (inv.status, inv.match_status) == ("approved", "matched")
    inv = subledger.post_supplier_invoice(ctx(p2p["clerk"]), inv)
    assert gl_balance(books, "2150") == D("0")  # GRNI cleared
    assert gl_balance(books, "1400") == D("2250") and gl_balance(books, "1410") == D("2250")
    assert gl_balance(books, "2100") == D("-29500")
    assert OpenItem.objects.get(document_id=inv.pk).due_date == TODAY() + timedelta(days=45)
    with pytest.raises(Exception, match="already recorded"):
        invoice(ctx, p2p, books)  # duplicate supplier invoice number


def test_price_variance_needs_approval_and_posts_ppv(ctx, p2p, books):
    MatchTolerance.objects.create(company=books, price_pct=D("1"), price_abs=D("100"))
    inv = subledger.submit_supplier_invoice(ctx(p2p["clerk"]), invoice(ctx, p2p, books, rate="260"))
    assert (inv.status, inv.match_status) == ("submitted", "variance")
    with pytest.raises(InvalidStateTransition):
        subledger.post_supplier_invoice(ctx(p2p["clerk"]), inv)  # variance awaits approval
    inv = workflow.decide_directly(ctx(p2p["controller"]), inv, document_type=subledger.AP_INVOICE, approve=True)
    subledger.post_supplier_invoice(ctx(p2p["clerk"]), inv)
    assert gl_balance(books, "5110") == D("1000")  # 100 x ₹10 over PO price
    assert gl_balance(books, "2150") == D("0")


def test_quantity_overbilling_is_blocked(ctx, p2p, books):
    with pytest.raises(BusinessRuleViolation) as exc:
        subledger.submit_supplier_invoice(ctx(p2p["clerk"]), invoice(ctx, p2p, books, qty="120"))
    assert exc.value.code == "match_failed"


@pytest.mark.req("FIN-007")
def test_payment_controls_bank_reconciliation_and_close(ctx, p2p, books, fiscal_year):
    clerk, controller = ctx(p2p["clerk"]), ctx(p2p["controller"])
    inv = subledger.post_supplier_invoice(clerk, subledger.submit_supplier_invoice(clerk, invoice(ctx, p2p, books)))
    item = OpenItem.objects.get(document_id=inv.pk)
    payment = subledger.create_payment(
        clerk,
        company=books,
        kind="supplier_payment",
        partner=p2p["supplier"],
        bank_account=p2p["bank"],
        payment_date=TODAY(),
        mode="neft",
        amount=D("29500"),
        allocations=[{"open_item": item, "amount": D("29500")}],
        reference="UTR-778",
    )
    subledger.submit_payment(clerk, payment)
    with pytest.raises(AuthorizationDenied):
        workflow.decide_directly(clerk, payment, document_type=subledger.PAYMENT, approve=True)
    payment = workflow.decide_directly(controller, payment, document_type=subledger.PAYMENT, approve=True)
    with pytest.raises(BusinessRuleViolation) as exc:
        subledger.post_payment(clerk, payment)
    assert exc.value.code == "bank_account_unverified"
    account = add_bank_account(
        clerk,
        p2p["supplier"],
        bank_name="SBI",
        ifsc="SBIN0001234",
        account_holder="Kolhapur Castings",
        account_number="123456789012",
    )
    with pytest.raises(AuthorizationDenied):
        review_bank_account(clerk, account, approve=True)  # entered by the clerk
    review_bank_account(ctx(p2p["head"]), account, approve=True)
    assert PartnerBankAccount.objects.get(pk=account.pk).account_last4 == "9012"
    payment = subledger.post_payment(clerk, payment)
    assert gl_balance(books, "2100") == D("0") and gl_balance(books, "1110") == D("-29500")

    csv = (
        "date,description,reference,debit,credit,balance\n"
        f"{TODAY()},NEFT KOLHAPUR CASTINGS,UTR-778,29500,,70500\n"
        f"{TODAY()},Bank charges,,59,,70441\n"
    )
    result = subledger.import_statement(clerk, p2p["bank"], csv)
    assert (result["imported"], result["auto_matched"]) == (2, 1)
    recon = subledger.reconciliation(p2p["bank"], TODAY())
    assert recon["unmatched_statement_lines"] == 1 and recon["unreconciled_book_items"] == []
    assert BankStatementLine.objects.get(reference="UTR-778").matched_line.entry_id == payment.journal_entry_id

    checks = {c["check"]: c["ok"] for c in subledger.subledger_reconciliation(books.pk, TODAY())}
    assert checks == {"inventory": True, "receivable": True, "payable": True}
    # Close every period up to and including the one with this activity, oldest first.
    periods = list(fiscal_year.periods.filter(start_date__lte=TODAY()).order_by("period_no"))
    with pytest.raises(BusinessRuleViolation) as exc:
        subledger.close_period(controller, periods[-1])
    assert exc.value.code == "earlier_period_open" or len(periods) == 1
    for period in periods:
        subledger.close_period(controller, period)
        period.refresh_from_db()
        assert period.status == "closed" and period.gl_locked
    with pytest.raises(ValidationError, match="Already imported"):
        subledger.import_statement(clerk, p2p["bank"], csv)  # overlapping statement file


@pytest.mark.req("PRC-001")
def test_mrp_suggests_purchases_from_reorder_policy_and_demand(ctx, p2p, books, plant, make_user, grant):
    from apps.masterdata.models import ItemWarehousePolicy

    ItemWarehousePolicy.objects.create(
        company=books, item=p2p["item"], warehouse=plant["rm"], reorder_level=D("150"), reorder_quantity=D("200")
    )
    planner = make_user()
    grant(planner, ["procurement.mrp.create", "procurement.mrp.read"], books)
    run = mrp.run_mrp(ctx(planner), books)
    suggestion = run.suggestions.get()
    assert (suggestion.on_hand, suggestion.action) == (D("100"), "purchase")
    assert suggestion.suggested_quantity == D("200")  # reorder quantity covers the 50 shortfall
