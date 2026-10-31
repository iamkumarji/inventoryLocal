from decimal import Decimal

import pytest
from django.db import DatabaseError, transaction
from django.utils import timezone

from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation
from apps.core.ids import uuid7
from apps.core.models import FeatureFlag
from apps.inventory import selectors
from apps.inventory.engine import Move, post_stock
from apps.manufacturing import services
from apps.manufacturing.models import Bom, BomComponent, WorkCenter
from conftest import gl_balance

pytestmark = [pytest.mark.django_db, pytest.mark.req("MFG-011")]
D = Decimal
TODAY = timezone.localdate
PERMS = [
    "manufacturing.production_order." + a for a in ("create", "read", "release", "issue", "confirm", "receive", "close")
]


@pytest.fixture(autouse=True)
def modules(db):
    for key in ("module.manufacturing", "module.inventory"):
        FeatureFlag.objects.create(key=key, enabled_default=True)


@pytest.fixture
def factory(org, books, plant, make_item, make_user, grant, ctx, system_ctx):
    steel = make_item("STEEL")
    paint = make_item("PAINT")
    bracket = make_item("BRACKET", group="SFG", item_type="semi_finished", is_manufactured=True)
    cabinet = make_item(
        "CABINET", group="FG", uom="nos", item_type="finished_good", is_manufactured=True, standard_cost=D("650")
    )
    engineer, approver, supervisor = make_user(), make_user(), make_user()
    grant(engineer, ["manufacturing.bom.create", "manufacturing.bom.update", "manufacturing.bom.read"], org)
    grant(approver, ["manufacturing.bom.approve", "manufacturing.bom.read"], org)
    grant(supervisor, PERMS, plant["facility"])
    WorkCenter.objects.create(
        company=books,
        facility=plant["facility"],
        code="ASM",
        name="Assembly",
        labour_rate=D("300"),
        overhead_rate=D("120"),
    )

    def approved_bom(item, components, operations=(), output=D("1")):
        bom = Bom.objects.create(organization=org, item=item, code=f"BOM-{item.code}", name=item.name)
        version = services.create_bom_version(
            ctx(engineer),
            bom,
            effective_from=TODAY(),
            output_quantity=output,
            components=components,
            operations=list(operations),
        )
        services.approve_bom_version(ctx(approver), version)
        return bom, version

    approved_bom(bracket, [{"item": steel, "quantity": D("2")}])
    bom, version = approved_bom(
        cabinet,
        [{"item": bracket, "quantity": D("4")}, {"item": paint, "quantity": D("0.5"), "issue_method": "backflush"}],
        operations=[
            {
                "sequence": 10,
                "name": "Assemble and paint",
                "work_center_code": "ASM",
                "setup_minutes": D("30"),
                "run_minutes_per_unit": D("15"),
            }
        ],
    )
    with transaction.atomic():
        post_stock(
            system_ctx,
            company_id=books.pk,
            posting_date=TODAY(),
            source_type="test.opening",
            source_id=uuid7(),
            moves=[
                Move(
                    item=steel,
                    warehouse=plant["rm"],
                    quantity=D("100"),
                    movement_type="opening",
                    unit_cost=D("50"),
                    contra_key="inventory_adjustment",
                ),
                Move(
                    item=paint,
                    warehouse=plant["rm"],
                    quantity=D("10"),
                    movement_type="opening",
                    unit_cost=D("200"),
                    contra_key="inventory_adjustment",
                ),
                Move(
                    item=bracket,
                    warehouse=plant["rm"],
                    quantity=D("40"),
                    movement_type="opening",
                    unit_cost=D("120"),
                    contra_key="inventory_adjustment",
                ),
            ],
        )
    return {
        "steel": steel,
        "paint": paint,
        "bracket": bracket,
        "cabinet": cabinet,
        "bom": bom,
        "version": version,
        "engineer": engineer,
        "approver": approver,
        "supervisor": supervisor,
    }


@pytest.mark.req("MFG-001")
def test_multi_level_explosion(factory):
    tree = services.explode(factory["cabinet"], D("10"), TODAY())
    assert services.flatten(tree) == {str(factory["steel"].pk): D("80"), str(factory["paint"].pk): D("5")}
    assert tree["children"][0]["children"][0]["quantity"] == D("80")


@pytest.mark.req("MFG-002")
def test_bom_versions_are_maker_checker_and_frozen(factory, ctx):
    with pytest.raises(AuthorizationDenied):
        version = services.create_bom_version(
            ctx(factory["engineer"]),
            factory["bom"],
            effective_from=TODAY(),
            output_quantity=D("1"),
            components=[{"item": factory["bracket"], "quantity": D("5")}],
        )
        services.approve_bom_version(ctx(factory["engineer"]), version)
    with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
        BomComponent.objects.filter(version=factory["version"]).update(quantity=D("9"))
    with pytest.raises(BusinessRuleViolation) as exc:
        services.create_bom_version(
            ctx(factory["engineer"]),
            Bom.objects.get(item=factory["bracket"]),
            effective_from=TODAY(),
            output_quantity=D("1"),
            components=[{"item": factory["cabinet"], "quantity": D("1")}],
        )
    assert exc.value.code == "bom_cycle"


@pytest.mark.req("MFG-009")
def test_production_actual_costing_end_to_end(factory, ctx, books, plant):
    sup = ctx(factory["supervisor"])
    order = services.create_order(
        sup,
        company=books,
        facility=plant["facility"],
        item=factory["cabinet"],
        quantity=D("10"),
        planned_start=TODAY(),
        planned_end=TODAY(),
        source_warehouse=plant["rm"],
        wip_warehouse=plant["wip"],
        output_warehouse=plant["fg"],
    )
    order = services.release_order(sup, order)
    assert selectors.availability(books.pk, factory["bracket"].pk, plant["rm"].pk)["available"] == D("0")
    brackets = order.materials.get(item=factory["bracket"])
    with pytest.raises(BusinessRuleViolation) as exc:
        services.receive_output(sup, order, quantity=D("4"), on=TODAY())
    assert exc.value.code == "materials_not_issued"
    services.issue_materials(sup, order, lines=[{"material": brackets, "quantity": D("40")}], on=TODAY())
    services.confirm_operation(sup, order.operations.get(), minutes=D("180"), quantity=D("10"))
    order = services.receive_output(sup, order, quantity=D("4"), on=TODAY())
    assert order.absorbed_conversion == D("504")
    order = services.receive_output(sup, order, quantity=D("6"), on=TODAY())
    assert order.status == "completed"
    cost = services.costing(order)
    assert (D(cost["material_cost"]), D(cost["absorbed_conversion"]), D(cost["unit_cost"])) == (
        D("5800"),
        D("1260"),
        D("706"),
    )
    assert D(cost["variance_per_unit"]) == D("56")  # vs standard ₹650
    fg = selectors.availability(books.pk, factory["cabinet"].pk, plant["fg"].pk)
    assert (fg["on_hand"], fg["value"]) == (D("10"), D("7060"))
    # Ledger and GL agree: WIP cleared, FG at actual cost, conversion credited to absorption accounts.
    assert gl_balance(books, "1310") == D("0")
    assert gl_balance(books, "1320") == D("7060")
    assert gl_balance(books, "1300") == D("6000")  # steel 5,000 + paint 2,000 - 1,000 backflushed
    assert gl_balance(books, "5300") == D("-900") and gl_balance(books, "5310") == D("-360")
    order = services.close_order(sup, order, on=TODAY())
    assert order.status == "closed"


@pytest.mark.req("MFG-010")
def test_scrap_and_leftover_wip_returned_on_close(factory, ctx, books, plant):
    sup = ctx(factory["supervisor"])
    order = services.release_order(
        sup,
        services.create_order(
            sup,
            company=books,
            facility=plant["facility"],
            item=factory["cabinet"],
            quantity=D("5"),
            planned_start=TODAY(),
            planned_end=TODAY(),
            source_warehouse=plant["rm"],
            wip_warehouse=plant["wip"],
            output_warehouse=plant["fg"],
        ),
    )
    brackets = order.materials.get(item=factory["bracket"])
    services.issue_materials(sup, order, lines=[{"material": brackets, "quantity": D("20")}], on=TODAY())
    services.record_scrap(sup, order, material=brackets, quantity=D("2"), on=TODAY(), reason="Bent in press")
    assert gl_balance(books, "5140") == D("240")
    services.receive_output(sup, order, quantity=D("3"), on=TODAY())  # consumes 12 brackets
    order = services.close_order(sup, order, on=TODAY())
    brackets.refresh_from_db()
    assert brackets.returned_quantity == D("6")  # 20 issued - 2 scrapped - 12 consumed
    assert selectors.availability(books.pk, factory["bracket"].pk, plant["wip"].pk)["on_hand"] == D("0")
    assert gl_balance(books, "1310") == D("0")


@pytest.mark.req("MFG-010")
def test_scrap_does_not_reduce_what_the_final_receipt_consumes(factory, ctx, books, plant):
    # Regression: the final receipt consumed `required - consumed`, and scrap counts as consumed, so
    # a scrapped bracket left a phantom one in WIP (returned to stores on close) and under-costed output.
    sup = ctx(factory["supervisor"])
    order = services.release_order(
        sup,
        services.create_order(
            sup,
            company=books,
            facility=plant["facility"],
            item=factory["cabinet"],
            quantity=D("5"),
            planned_start=TODAY(),
            planned_end=TODAY(),
            source_warehouse=plant["rm"],
            wip_warehouse=plant["wip"],
            output_warehouse=plant["fg"],
        ),
    )
    brackets = order.materials.get(item=factory["bracket"])
    assert brackets.required_quantity == D("20")
    services.issue_materials(sup, order, lines=[{"material": brackets, "quantity": D("22")}], on=TODAY())
    services.record_scrap(sup, order, material=brackets, quantity=D("2"), on=TODAY(), reason="Bent in press")
    services.receive_output(sup, order, quantity=D("5"), on=TODAY())  # all five need 20 brackets
    brackets.refresh_from_db()
    assert brackets.consumed_quantity == D("22")  # 20 into output + 2 scrapped
    order = services.close_order(sup, order, on=TODAY())
    brackets.refresh_from_db()
    assert brackets.returned_quantity == D("0")
    assert selectors.availability(books.pk, factory["bracket"].pk, plant["wip"].pk)["on_hand"] == D("0")


def test_release_audit_summary_shows_plain_quantities(factory, ctx, books, plant):
    # Regression: Decimal.normalize() rendered 10 as "1E+1" in the activity timeline.
    from apps.audit.models import AuditEvent

    sup = ctx(factory["supervisor"])
    order = services.release_order(
        sup,
        services.create_order(
            sup,
            company=books,
            facility=plant["facility"],
            item=factory["cabinet"],
            quantity=D("10"),
            planned_start=TODAY(),
            planned_end=TODAY(),
            source_warehouse=plant["rm"],
            wip_warehouse=plant["wip"],
            output_warehouse=plant["fg"],
        ),
    )
    event = AuditEvent.objects.get(resource_id=str(order.pk), action="manufacturing.production_order.released")
    assert event.summary == f"{order.number}: 10 x CABINET"


def test_bom_versions_name_their_maker_and_approver(factory, api_for, books):
    # The BOM screen shows "drafted by … · approved by …"; ids alone can't be shown to people.
    response = api_for(factory["approver"], company=books).get(f"/api/v1/manufacturing/boms/{factory['bom'].pk}/")
    assert response.status_code == 200
    version = response.json()["versions"][0]
    assert version["created_by_name"] == factory["engineer"].full_name
    assert version["approved_by_name"] == factory["approver"].full_name
