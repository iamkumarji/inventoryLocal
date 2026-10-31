from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.authorization.models import ApprovalLimit
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation
from apps.core.models import FeatureFlag
from apps.inventory import selectors
from apps.masterdata.models import HsnCode
from apps.partners.models import Partner, SupplierProfile
from apps.partners.services import approve_supplier
from apps.procurement import services
from apps.quality import services as quality
from apps.shared import workflow
from conftest import gl_balance

pytestmark = [pytest.mark.django_db, pytest.mark.req("PRC-005")]
D = Decimal
TODAY = timezone.localdate


@pytest.fixture(autouse=True)
def modules(db):
    for key in ("module.procurement", "module.inventory", "module.quality", "module.partners"):
        FeatureFlag.objects.create(key=key, enabled_default=True)


@pytest.fixture
def team(make_user, grant, make_role, plant, books, org):
    buyer, head, keeper, inspector = (make_user(full_name=n) for n in ("Buyer", "Head", "Keeper", "Inspector"))
    grant(
        buyer,
        [
            "procurement.purchase_requisition.create",
            "procurement.purchase_requisition.update",
            "procurement.rfq.create",
            "procurement.rfq.update",
            "procurement.rfq.read",
            "procurement.purchase_order.create",
            "procurement.purchase_order.update",
            "procurement.purchase_order.read",
            "partners.partner.create",
        ],
        plant["branch"],
    )
    head_role = make_role(
        [
            "procurement.purchase_requisition.approve",
            "procurement.purchase_order.approve",
            "procurement.rfq.approve",
            "partners.supplier.approve",
            "procurement.rfq.read",
        ]
    )
    grant(head, [], books, role=head_role)
    for doc in ("procurement.purchase_order", "procurement.purchase_requisition"):
        ApprovalLimit.objects.create(
            organization=org, role=head_role, document_type=doc, currency="INR", max_amount=D("1000000")
        )
    grant(
        keeper,
        [
            "procurement.goods_receipt.create",
            "procurement.goods_receipt.post",
            "procurement.purchase_return.create",
            "procurement.purchase_return.post",
        ],
        plant["rm"],
    )
    grant(inspector, ["quality.inspection.approve", "quality.inspection.read"], plant["rm"])
    return {"buyer": buyer, "head": head, "keeper": keeper, "inspector": inspector}


@pytest.fixture
def supplier(org, team, ctx):
    p = Partner.objects.create(
        organization=org,
        code=f"S{org.code}",
        name="Deccan Steels",
        is_supplier=True,
        gstin="27AAPFU0939F1ZV",
        state_code="27",
        created_by=team["buyer"],
    )
    SupplierProfile.objects.create(organization=org, partner=p)
    approve_supplier(ctx(team["head"]), p)
    return p


@pytest.fixture
def steel(make_item, org):
    hsn = HsnCode.objects.create(organization=org, code="7208", description="Hot-rolled steel", gst_rate=D("18"))
    return make_item("HR-COIL", hsn=hsn, inspection_required=True)


def approved_po(ctx, team, books, plant, supplier, item, uom, qty="100", rate="80"):
    po = services.create_order(
        ctx(team["buyer"]),
        company=books,
        branch=plant["branch"],
        supplier=supplier,
        order_date=TODAY(),
        expected_date=TODAY() + timedelta(days=7),
        lines=[{"item": item, "quantity": D(qty), "uom": uom, "rate": D(rate), "warehouse": plant["rm"]}],
    )
    services.submit_order(ctx(team["buyer"]), po)
    return workflow.decide_directly(ctx(team["head"]), po, document_type=services.PO, approve=True)


def test_vendor_onboarding_is_maker_checker(org, team, ctx, plant, books, uoms, steel):
    p = Partner.objects.create(
        organization=org,
        code="NEWV",
        name="New vendor",
        is_supplier=True,
        gst_registration="unregistered",
        created_by=team["buyer"],
    )
    SupplierProfile.objects.create(organization=org, partner=p)
    with pytest.raises(BusinessRuleViolation, match="approved vendor"):
        services.create_order(
            ctx(team["buyer"]),
            company=books,
            branch=plant["branch"],
            supplier=p,
            order_date=TODAY(),
            expected_date=TODAY(),
            lines=[{"item": steel, "quantity": D(1), "uom": uoms["kg"], "rate": D(1), "warehouse": plant["rm"]}],
        )
    team["buyer"].refresh_from_db()
    with pytest.raises(AuthorizationDenied):
        approve_supplier(ctx(team["buyer"]), p)  # creator can't approve their own vendor
    approve_supplier(ctx(team["head"]), p)


@pytest.mark.req("FIN-008")
def test_gst_split_by_place_of_supply(ctx, team, books, plant, supplier, steel, uoms, org):
    plant["branch"].state_code = "27"
    plant["branch"].save()
    intra = services.create_order(
        ctx(team["buyer"]),
        company=books,
        branch=plant["branch"],
        supplier=supplier,
        order_date=TODAY(),
        expected_date=TODAY(),
        lines=[
            {
                "item": steel,
                "quantity": D("10"),
                "uom": uoms["kg"],
                "rate": D("100"),
                "discount_pct": D("10"),
                "warehouse": plant["rm"],
            }
        ],
    )
    line = intra.lines.get()
    assert (line.taxable_amount, line.cgst, line.sgst, line.igst) == (D("900"), D("81"), D("81"), D("0"))
    assert intra.amount == D("1062")
    supplier.state_code = "29"
    supplier.gstin = "29AAPFU0939F1ZV"
    supplier.save()
    inter = services.create_order(
        ctx(team["buyer"]),
        company=books,
        branch=plant["branch"],
        supplier=supplier,
        order_date=TODAY(),
        expected_date=TODAY(),
        lines=[
            {
                "item": steel,
                "quantity": D("10"),
                "uom": uoms["kg"],
                "rate": D("100"),
                "discount_pct": D("10"),
                "warehouse": plant["rm"],
            }
        ],
    )
    assert inter.lines.get().igst == D("162") and not inter.intra_state


@pytest.mark.req("PRC-004")
def test_requisition_rfq_comparison_selection(ctx, team, books, plant, supplier, steel, uoms, org):
    pr = services.create_requisition(
        ctx(team["buyer"]),
        company=books,
        branch=plant["branch"],
        needed_by=TODAY() + timedelta(days=10),
        purpose="Coil for press line",
        lines=[
            {
                "item": steel,
                "quantity": D("500"),
                "uom": uoms["kg"],
                "estimated_rate": D("75"),
                "warehouse": plant["rm"],
            }
        ],
    )
    with pytest.raises(BusinessRuleViolation):
        services.create_rfq(
            ctx(team["buyer"]),
            company=books,
            branch=plant["branch"],
            respond_by=TODAY(),
            suppliers=[supplier],
            lines=[],
            requisition=pr,
        )  # not approved yet
    services.submit_requisition(ctx(team["buyer"]), pr)
    workflow.decide_directly(ctx(team["head"]), pr, document_type=services.PR, approve=True)
    cheap = Partner.objects.create(
        organization=org,
        code="CHEAP",
        name="Budget Metals",
        is_supplier=True,
        gst_registration="unregistered",
        created_by=team["buyer"],
    )
    SupplierProfile.objects.create(organization=org, partner=cheap, rating=D("60"))
    approve_supplier(ctx(team["head"]), cheap)
    pr.refresh_from_db()
    rfq = services.create_rfq(
        ctx(team["buyer"]),
        company=books,
        branch=plant["branch"],
        respond_by=TODAY(),
        suppliers=[supplier, cheap],
        lines=[],
        requisition=pr,
    )
    rfq_line = rfq.lines.get()
    q1 = services.record_quotation(
        ctx(team["buyer"]),
        rfq,
        supplier=supplier,
        received_on=TODAY(),
        valid_until=TODAY() + timedelta(days=30),
        lead_time_days=5,
        lines=[{"rfq_line": rfq_line, "rate": D("78")}],
    )
    q2 = services.record_quotation(
        ctx(team["buyer"]),
        rfq,
        supplier=cheap,
        received_on=TODAY(),
        valid_until=TODAY() + timedelta(days=30),
        lead_time_days=20,
        lines=[{"rfq_line": rfq_line, "rate": D("74")}],
    )
    ranking = services.compare_quotations(rfq)
    assert {r["quotation_id"] for r in ranking} == {str(q1.pk), str(q2.pk)}
    assert next(r for r in ranking if r["quotation_id"] == str(q2.pk))["is_cheapest"]
    with pytest.raises(Exception, match="cheapest"):
        services.select_quotation(ctx(team["head"]), q1, reason="", warehouse=plant["rm"], expected_date=TODAY())
    po = services.select_quotation(
        ctx(team["head"]),
        q1,
        reason="Faster delivery; line stops otherwise.",
        warehouse=plant["rm"],
        expected_date=TODAY() + timedelta(days=5),
    )
    assert po.status == "draft" and po.lines.get().rate == D("78") and po.requisition_id == pr.pk
    assert pr.lines.get().ordered_quantity == D("500")


def test_po_approval_respects_self_approval(ctx, team, books, plant, supplier, steel, uoms, grant, make_role):
    po = services.create_order(
        ctx(team["buyer"]),
        company=books,
        branch=plant["branch"],
        supplier=supplier,
        order_date=TODAY(),
        expected_date=TODAY(),
        lines=[{"item": steel, "quantity": D("10"), "uom": uoms["kg"], "rate": D("10"), "warehouse": plant["rm"]}],
    )
    services.submit_order(ctx(team["buyer"]), po)
    grant(team["buyer"], ["procurement.purchase_order.approve"], books)
    with pytest.raises(AuthorizationDenied):
        workflow.decide_directly(ctx(team["buyer"]), po, document_type=services.PO, approve=True)


@pytest.mark.req("PRC-006")
def test_receipt_with_conversion_quality_hold_inspection_and_return(ctx, team, books, plant, supplier, steel, uoms):
    po = approved_po(ctx, team, books, plant, supplier, steel, uoms["bag"], qty="10", rate="2000")  # 10 bags x 25 kg
    po_line = po.lines.get()
    with pytest.raises(BusinessRuleViolation) as exc:  # refused up front: no impossible draft is left behind
        services.create_receipt(
            ctx(team["keeper"]),
            order=po,
            warehouse=plant["rm"],
            receipt_date=TODAY(),
            lines=[{"po_line": po_line, "quantity": D("11")}],
        )
    assert exc.value.code == "over_receipt"
    assert not po.receipts.exists()
    grn = services.create_receipt(
        ctx(team["keeper"]),
        order=po,
        warehouse=plant["rm"],
        receipt_date=TODAY(),
        lines=[{"po_line": po_line, "quantity": D("10")}],
    )
    grn = services.post_receipt(ctx(team["keeper"]), grn)
    line = grn.lines.get()
    assert (line.stock_quantity, line.unit_cost) == (D("250"), D("80"))  # ₹2000/bag = ₹80/kg
    avail = selectors.availability(books.pk, steel.pk, plant["rm"].pk)
    assert (avail["quality_hold"], avail["available"]) == (D("250"), D("0"))
    assert gl_balance(books, "1300") == D("20000") and gl_balance(books, "2150") == D("-20000")
    po.refresh_from_db()
    assert po.receipt_status == "received"

    inspection = line.inspection
    with pytest.raises(Exception, match="why"):
        quality.decide(ctx(team["inspector"]), inspection, accepted_quantity=D("240"), rejected_quantity=D("10"))
    quality.decide(
        ctx(team["inspector"]),
        inspection,
        accepted_quantity=D("240"),
        rejected_quantity=D("10"),
        remarks="Edge cracks on one coil",
    )
    avail = selectors.availability(books.pk, steel.pk, plant["rm"].pk)
    assert (avail["available"], avail["blocked"], avail["quality_hold"]) == (D("240"), D("10"), D("0"))
    assert inspection.ncrs.count() == 1
    supplier.supplier_profile.refresh_from_db()
    assert supplier.supplier_profile.rating == D("96.00")

    ret = services.create_return(
        ctx(team["keeper"]),
        receipt=grn,
        return_date=TODAY(),
        reason="Rejected in QC",
        lines=[{"receipt_line": line, "quantity": D("0.4"), "from_status": "blocked"}],
    )
    services.post_return(ctx(team["keeper"]), ret)
    assert selectors.availability(books.pk, steel.pk, plant["rm"].pk)["blocked"] == D("0")
    assert gl_balance(books, "2150") == D("-19200")  # GRNI reduced by 10 kg x ₹80
    po.refresh_from_db()
    assert po.receipt_status == "partially_received"
    with pytest.raises(BusinessRuleViolation):
        services.post_return(
            ctx(team["keeper"]),
            services.create_return(
                ctx(team["keeper"]),
                receipt=grn,
                return_date=TODAY(),
                reason="again",
                lines=[{"receipt_line": line, "quantity": D("10"), "from_status": "unrestricted"}],
            ),
        )


@pytest.mark.req("PRC-006")
def test_two_drafts_cannot_together_exceed_the_order(ctx, team, books, plant, supplier, steel, uoms):
    po = approved_po(ctx, team, books, plant, supplier, steel, uoms["bag"], qty="10", rate="2000")
    keeper = ctx(team["keeper"])

    def draft(qty):
        return services.create_receipt(
            keeper,
            order=po,
            warehouse=plant["rm"],
            receipt_date=TODAY(),
            lines=[{"po_line": po.lines.get(), "quantity": D(qty)}],
        )

    first, second = draft("6"), draft("6")  # each fits on its own
    services.post_receipt(keeper, first)
    with pytest.raises(BusinessRuleViolation) as exc:  # posting re-checks against what is received now
        services.post_receipt(keeper, second)
    assert exc.value.code == "over_receipt"
