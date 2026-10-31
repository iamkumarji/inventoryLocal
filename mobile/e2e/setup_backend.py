"""DEMO data for the mobile end-to-end run (development only; run after bootstrap_erp + seed_demo).

    DATABASE_URL=postgres:///otabu_erp_mobile .venv/bin/python manage.py shell < ../mobile/e2e/setup_backend.py

Everything goes through the real services (stock engine, procurement, sales, logistics, HR) under a
system context, as an installation script would. Users are DEMO-labelled and share the demo password.
"""

from datetime import date, timedelta
from decimal import Decimal as D

from django.db import transaction
from django.utils import timezone

from apps.approvals.management.commands.seed_demo import DEMO_PASSWORD
from apps.authorization import services as authz
from apps.core.context import ActorContext
from apps.core.ids import uuid7
from apps.core.models import FeatureFlag
from apps.expenses.models import ExpenseCategory
from apps.hr import services as hr
from apps.identity.models import User
from apps.inventory import documents as stock_docs
from apps.inventory.engine import Move, post_stock
from apps.logistics import services as logistics
from apps.logistics.models import Driver, Vehicle
from apps.masterdata.models import HsnCode, Item, ItemBarcode, ItemCategory, Uom
from apps.organization.models import Branch, Department, Organization, Warehouse
from apps.partners.models import CustomerProfile, Partner, SupplierProfile
from apps.partners.services import approve_supplier
from apps.procurement import services as procurement
from apps.sales import services as sales
from apps.shared import workflow

org = Organization.objects.get(code="DEMO")
company = org.companies.order_by("created_at").first()
# Installation-script authority, attributed to the bootstrap admin so documents record a real actor.
ctx = ActorContext(user=User.objects.get(email="admin@demo.local"), company_id=company.pk, is_system=True,
                   client_type="system", extra={"reason": "mobile_e2e_setup"})
today = timezone.localdate()
pune = Branch.objects.get(company=company, code="PUN")
rm = Warehouse.objects.get(code="PUN-RM")
fg = Warehouse.objects.get(code="PUN-FG")
chakan = Warehouse.objects.get(code="CHK-RM")
stores = Department.objects.get(company=company, code="STORES")

with transaction.atomic():
    for module in ("masterdata", "partners", "inventory", "procurement", "sales", "logistics", "hr", "expenses", "documents"):
        FeatureFlag.objects.filter(key=f"module.{module}").update(enabled_default=True)
    company.state_code = "27"
    company.save(update_fields=["state_code"])

    kg = Uom.objects.create(organization=org, code="KG", name="Kilogram (DEMO)", kind="mass", decimals=3)
    nos = Uom.objects.create(organization=org, code="NOS", name="Numbers (DEMO)", kind="count", decimals=0)
    rm_cat = ItemCategory.objects.create(organization=org, code="RM", name="Raw material (DEMO)", posting_group="RM")
    fg_cat = ItemCategory.objects.create(organization=org, code="FG", name="Finished goods (DEMO)", posting_group="FG")
    hsn = HsnCode.objects.create(organization=org, code="7208", description="Steel sheet (DEMO)", gst_rate=D("18"))
    sheet = Item.objects.create(organization=org, code="CRC-SHEET", name="CRC sheet 1.2 mm (DEMO)", item_type="raw_material",
                                category=rm_cat, stock_uom=kg, hsn=hsn)
    ItemBarcode.objects.create(organization=org, item=sheet, barcode="8901234567890")
    bolt = Item.objects.create(organization=org, code="BOLT-M8", name="Hex bolt M8 (DEMO)", item_type="raw_material",
                               category=rm_cat, stock_uom=nos)
    rack = Item.objects.create(organization=org, code="RACK-01", name="Storage rack (DEMO)", item_type="finished_good",
                               category=fg_cat, stock_uom=nos, hsn=hsn, is_saleable=True)

    post_stock(ctx, company_id=company.pk, posting_date=today, source_type="demo.opening", source_id=uuid7(), moves=[
        Move(item=sheet, warehouse=rm, quantity=D("250"), movement_type="opening", unit_cost=D("68"), contra_key="inventory_adjustment"),
        Move(item=bolt, warehouse=rm, quantity=D("400"), movement_type="opening", unit_cost=D("4"), contra_key="inventory_adjustment"),
        Move(item=bolt, warehouse=chakan, quantity=D("300"), movement_type="opening", unit_cost=D("4"), contra_key="inventory_adjustment"),
        Move(item=rack, warehouse=fg, quantity=D("10"), movement_type="opening", unit_cost=D("2400"), contra_key="inventory_adjustment"),
    ])

    def user(email, name):
        return User.objects.create_user(email, DEMO_PASSWORD, full_name=name, organization=org, default_company=company)

    def grant(person, code, codes, scope_type, scope_id):
        role = authz.create_role(ctx, organization=org, code=code, name=code.replace("_", " ").title() + " (DEMO)",
                                 permission_codes=codes)
        authz.assign_role(ctx, user=person, role=role, scope_type=scope_type, scope_id=scope_id, reason="Mobile DEMO")
        return role

    storekeeper = user("sunil.stores@demo.local", "Sunil Patil (DEMO)")
    grant(storekeeper, "demo_mobile_stores", [
        "masterdata.item.read", "inventory.stock_balance.read", "inventory.stock_ledger.read",
        "procurement.purchase_order.read", "procurement.goods_receipt.create", "procurement.goods_receipt.read",
        "procurement.goods_receipt.post", "inventory.stock_count.read", "inventory.stock_count.update",
        "inventory.stock_transfer.read", "inventory.stock_transfer.receive", "documents.document.create",
        "expenses.expense_claim.create", "expenses.expense_claim.read", "expenses.expense_claim.update",
        "expenses.expense_category.read",
    ], "warehouse", rm.pk)
    # Purchase orders and expense categories are branch/company documents: read them at branch level too.
    grant(storekeeper, "demo_mobile_stores_branch", [
        "procurement.purchase_order.read", "expenses.expense_category.read", "expenses.expense_claim.create",
        "expenses.expense_claim.read", "expenses.expense_claim.update", "documents.document.create",
    ], "branch", pune.pk)
    # Expense categories are company-wide master data.
    grant(storekeeper, "demo_mobile_expense_setup", ["expenses.expense_category.read"], "company", company.pk)
    hr.create_employee(ctx, company=company, department=stores, code="E-STR-01", full_name="Sunil Patil (DEMO)",
                       date_of_joining=today - timedelta(days=400), user=storekeeper, branch=pune)
    ExpenseCategory.objects.create(company=company, code="TRAVEL", name="Local travel (DEMO)", gl_key="travel_expense",
                                   per_claim_limit=D("5000"), receipt_required_above=D("500"))

    supplier = Partner.objects.create(organization=org, code="SUP-DEMO", name="Kolhapur Steels (DEMO)", is_supplier=True,
                                      gstin="27AAPFU0939F1ZV", state_code="27")
    SupplierProfile.objects.create(organization=org, partner=supplier, payment_terms_days=30)
    approve_supplier(ctx, supplier)
    po = procurement.create_order(ctx, company=company, branch=pune, supplier=supplier, order_date=today, expected_date=today,
                                  lines=[{"item": sheet, "quantity": D("500"), "uom": kg, "rate": D("70"), "warehouse": rm}])
    procurement.submit_order(ctx, po)
    workflow.decide_directly(ctx, po, document_type=procurement.PO, approve=True)

    stock_docs.start_count(ctx, company=company, warehouse=rm, count_date=today, blind=True, item_ids=[bolt.pk])
    transfer = stock_docs.create_transfer(ctx, company=company, from_warehouse=chakan, to_warehouse=rm,
                                          lines=[{"item": bolt, "quantity": D("120")}])
    stock_docs.dispatch_transfer(ctx, transfer, on=today)

    driver_user = user("dinesh.driver@demo.local", "Dinesh More (DEMO)")
    grant(driver_user, "demo_mobile_driver", ["logistics.shipment.read", "logistics.shipment.deliver",
                                               "documents.document.create"], "branch", pune.pk)
    customer = Partner.objects.create(organization=org, code="CUS-DEMO", name="Metro Offices (DEMO)", is_customer=True,
                                      gstin="27AAACM1234A1Z5", state_code="27")
    CustomerProfile.objects.create(organization=org, partner=customer, credit_limit=D("500000"), credit_days=30)
    so = sales.create_order(ctx, company=company, branch=pune, customer=customer, order_date=today, requested_date=today,
                            lines=[{"item": rack, "quantity": D("4"), "uom": nos, "rate": D("3500"), "warehouse": fg}])
    so = sales.submit_order(ctx, so, on=today)
    delivery = sales.post_delivery(ctx, sales.create_delivery(ctx, order=so, warehouse=fg, delivery_date=today,
                                                              lines=[{"so_line": so.lines.get(), "quantity": D("4")}]))
    vehicle = Vehicle.objects.create(company=company, branch=pune, registration="MH12DE1433", vehicle_type="Tempo (DEMO)",
                                     insurance_expires_on=today + timedelta(days=200))
    driver = Driver.objects.create(company=company, branch=pune, user=driver_user, name="Dinesh More (DEMO)", phone="9800000000",
                                   licence_number="MH1220190001234", licence_expires_on=today + timedelta(days=900))
    shipment = logistics.plan_shipment(ctx, company=company, branch=pune, planned_date=today, deliveries=[delivery],
                                       vehicle=vehicle, driver=driver)
    logistics.dispatch(ctx, shipment)

print(f"mobile e2e DEMO data ready: PO {po.number}, transfer {transfer.number}, shipment {shipment.number}")
