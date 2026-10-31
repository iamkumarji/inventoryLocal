from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.authorization.models import ApprovalLimit
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation
from apps.core.ids import uuid7
from apps.core.models import FeatureFlag
from apps.finance import gst, subledger
from apps.finance.models import Account, BankAccount, OpenItem
from apps.inventory import selectors
from apps.inventory.engine import Move, post_stock
from apps.logistics import services as logistics
from apps.logistics.models import Driver, Vehicle
from apps.masterdata.models import HsnCode
from apps.partners.models import CustomerProfile, Partner
from apps.sales import services
from conftest import gl_balance

pytestmark = [pytest.mark.django_db, pytest.mark.req("SLS-005")]
D = Decimal
TODAY = timezone.localdate


@pytest.fixture(autouse=True)
def modules(db):
    for key in ("module.sales", "module.inventory", "module.finance", "module.logistics", "module.partners"):
        FeatureFlag.objects.create(key=key, enabled_default=True)


@pytest.fixture
def o2c(org, books, plant, make_item, make_user, grant, make_role, system_ctx, ctx, uoms):
    from django.db import transaction

    books.state_code = "27"
    books.save()
    plant["branch"].state_code = "27"
    plant["branch"].save()
    hsn = HsnCode.objects.create(organization=org, code="9403", description="Steel furniture", gst_rate=D("18"))
    cabinet = make_item("CAB-01", group="FG", uom="nos", item_type="finished_good", is_saleable=True, hsn=hsn)
    with transaction.atomic():
        post_stock(
            system_ctx,
            company_id=books.pk,
            posting_date=TODAY(),
            source_type="test.opening",
            source_id=uuid7(),
            moves=[
                Move(
                    item=cabinet,
                    warehouse=plant["fg"],
                    quantity=D("20"),
                    movement_type="opening",
                    unit_cost=D("700"),
                    contra_key="inventory_adjustment",
                )
            ],
        )
    customer = Partner.objects.create(
        organization=org, code="CUST1", name="Metro Offices", is_customer=True, gstin="27AAPFU0939F1ZV", state_code="27"
    )
    CustomerProfile.objects.create(organization=org, partner=customer, credit_limit=D("15000"), credit_days=30)
    seller, manager, accountant = make_user(), make_user(), make_user()
    grant(
        seller,
        [
            "sales.sales_order.create",
            "sales.sales_order.update",
            "sales.sales_order.read",
            "sales.quotation.create",
            "sales.quotation.read",
        ],
        plant["branch"],
    )
    grant(manager, ["sales.sales_order.credit_override", "sales.sales_order.read"], books)
    grant(
        accountant,
        [
            "sales.delivery.create",
            "sales.delivery.post",
            "sales.invoice.create",
            "sales.invoice.post",
            "sales.sales_return.create",
            "sales.sales_return.post",
            "finance.payment.create",
            "finance.payment.update",
            "finance.payment.post",
            "logistics.shipment.create",
            "logistics.shipment.dispatch",
            "logistics.shipment.deliver",
        ],
        books,
    )
    bank = BankAccount.objects.create(
        company=books, account=Account.objects.get(company=books, code="1110"), bank_name="State Bank"
    )
    return {
        "item": cabinet,
        "customer": customer,
        "seller": seller,
        "manager": manager,
        "acct": accountant,
        "bank": bank,
        "fg": plant["fg"],
        "branch": plant["branch"],
        "uoms": uoms,
    }


def order(ctx, o2c, books, qty="10", rate="1000"):
    return services.create_order(
        ctx(o2c["seller"]),
        company=books,
        branch=o2c["branch"],
        customer=o2c["customer"],
        order_date=TODAY(),
        requested_date=TODAY(),
        lines=[
            {
                "item": o2c["item"],
                "quantity": D(qty),
                "uom": o2c["uoms"]["nos"],
                "rate": D(rate),
                "warehouse": o2c["fg"],
            }
        ],
    )


@pytest.mark.req("SLS-002")
def test_credit_limit_blocks_and_override_needs_another_person(ctx, o2c, books):
    so = order(ctx, o2c, books)  # 10 x 1,000 + 18% = 11,800 within 15,000
    so = services.submit_order(ctx(o2c["seller"]), so, on=TODAY())
    assert (so.status, so.credit_status) == ("approved", "ok")
    second = order(ctx, o2c, books, qty="5")  # exposure 11,800 + 5,900 > 15,000
    second = services.submit_order(ctx(o2c["seller"]), second, on=TODAY())
    assert (second.status, second.credit_status) == ("submitted", "blocked")
    with pytest.raises(AuthorizationDenied):
        services.decide_credit(ctx(o2c["seller"]), second, approve=True, note="Good customer")
    second = services.decide_credit(ctx(o2c["manager"]), second, approve=True, note="Paid by cheque on delivery")
    assert (second.status, second.credit_status) == ("approved", "overridden")
    avail = selectors.availability(books.pk, o2c["item"].pk, o2c["fg"].pk)
    assert (avail["reserved"], avail["available"]) == (D("15"), D("5"))


@pytest.mark.req("SLS-005")
def test_order_to_cash_with_gl_gst_receipt_and_return(ctx, o2c, books, fiscal_year):
    acct = ctx(o2c["acct"])
    so = services.submit_order(ctx(o2c["seller"]), order(ctx, o2c, books), on=TODAY())
    line = so.lines.get()
    with pytest.raises(BusinessRuleViolation):
        services.create_invoice(acct, order=so, invoice_date=TODAY())  # nothing delivered yet
    delivery = services.create_delivery(
        acct, order=so, warehouse=o2c["fg"], delivery_date=TODAY(), lines=[{"so_line": line, "quantity": D("10")}]
    )
    services.post_delivery(acct, delivery)
    assert gl_balance(books, "5100") == D("7000")  # COGS at moving average
    assert selectors.availability(books.pk, o2c["item"].pk, o2c["fg"].pk)["reserved"] == D("0")

    inv = services.post_invoice(acct, services.create_invoice(acct, order=so, invoice_date=TODAY()))
    assert inv.number.startswith("SI/") and (inv.subtotal, inv.cgst, inv.sgst, inv.total) == (
        D("10000"),
        D("900"),
        D("900"),
        D("11800"),
    )
    assert gl_balance(books, "1200") == D("11800")
    assert gl_balance(books, "4100") == D("-10000") and gl_balance(books, "2200") == D("-900")
    item = OpenItem.objects.get(document_id=inv.pk)
    assert item.due_date == TODAY() + timedelta(days=30)

    receipt = subledger.create_payment(
        acct,
        company=books,
        kind="customer_receipt",
        partner=o2c["customer"],
        bank_account=o2c["bank"],
        payment_date=TODAY(),
        mode="neft",
        amount=D("12000"),
        allocations=[{"open_item": item, "amount": D("11800")}],
        reference="UTR123",
    )
    subledger.post_payment(acct, subledger.submit_payment(acct, receipt))
    item.refresh_from_db()
    assert not item.is_open and gl_balance(books, "1110") == D("12000")
    assert subledger.partner_exposure(books.pk, o2c["customer"].pk) == D("-200")  # advance on account

    ret = services.create_return(
        acct,
        invoice=inv,
        warehouse=o2c["fg"],
        return_date=TODAY(),
        reason="Dented",
        lines=[{"invoice_line": inv.lines.get(), "quantity": D("2"), "restock": False}],
    )
    ret = services.post_return(acct, ret)
    assert ret.credit_total == D("2360") and ret.number.startswith("CN/")
    assert selectors.availability(books.pk, o2c["item"].pk, o2c["fg"].pk)["blocked"] == D("2")
    assert gl_balance(books, "5100") == D("5600")  # COGS reversed at original cost
    assert gl_balance(books, "4110") == D("2000")

    r1 = gst.gstr1(books.pk, fiscal_year.start_date, fiscal_year.end_date)
    assert r1["b2b"][0]["gstin"] == "27AAPFU0939F1ZV" and r1["hsn_summary"][0]["hsn_code"] == "9403"
    r3 = gst.gstr3b(books.pk, fiscal_year.start_date, fiscal_year.end_date)
    assert r3["output_tax"]["cgst"] == D("900") and r3["credit_notes_total"] == D("2360")
    checks = {c["check"]: c for c in subledger.subledger_reconciliation(books.pk, TODAY())}
    assert checks["receivable"]["ok"] and checks["inventory"]["ok"]


@pytest.mark.req("LOG-004")
def test_shipment_requires_valid_documents_and_proof(ctx, o2c, books):
    acct = ctx(o2c["acct"])
    so = services.submit_order(ctx(o2c["seller"]), order(ctx, o2c, books, qty="2"), on=TODAY())
    delivery = services.post_delivery(
        acct,
        services.create_delivery(
            acct,
            order=so,
            warehouse=o2c["fg"],
            delivery_date=TODAY(),
            lines=[{"so_line": so.lines.get(), "quantity": D("2")}],
        ),
    )
    vehicle = Vehicle.objects.create(
        company=books,
        branch=o2c["branch"],
        registration="MH12AB1234",
        vehicle_type="Truck",
        insurance_expires_on=TODAY() - timedelta(days=1),
    )
    driver = Driver.objects.create(
        company=books,
        branch=o2c["branch"],
        name="Sanjay",
        phone="9",
        licence_number="DL1",
        licence_expires_on=TODAY() + timedelta(days=200),
    )
    shipment = logistics.plan_shipment(
        acct,
        company=books,
        branch=o2c["branch"],
        planned_date=TODAY(),
        deliveries=[delivery],
        vehicle=vehicle,
        driver=driver,
    )
    with pytest.raises(BusinessRuleViolation) as exc:
        logistics.dispatch(acct, shipment)
    assert exc.value.code == "documents_expired"
    vehicle.insurance_expires_on = TODAY() + timedelta(days=100)
    vehicle.save()
    logistics.dispatch(acct, shipment)
    with pytest.raises(Exception, match="signature"):
        logistics.record_proof(acct, shipment, delivery=delivery, outcome="delivered", received_by_name="Reception")
    logistics.record_proof(
        acct,
        shipment,
        delivery=delivery,
        outcome="delivered",
        received_by_name="Reception",
        signature_document_id=uuid7(),
        latitude=D("18.52"),
        longitude=D("73.85"),
    )
    shipment.refresh_from_db()
    assert shipment.status == "delivered"
    assert [r["document"] for r in logistics.expiring_documents(books.pk, 150)] == ["insurance"]


def test_approval_limits_do_not_apply_to_auto_approved_orders(ctx, o2c, books, org, make_role):
    # Orders within credit are approved by the system check; no human limit is involved.
    so = services.submit_order(ctx(o2c["seller"]), order(ctx, o2c, books, qty="1"), on=TODAY())
    assert so.approved_by_id is None and so.status == "approved"
    assert not ApprovalLimit.objects.filter(document_type="sales.sales_order").exists()
