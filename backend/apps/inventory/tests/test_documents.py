from decimal import Decimal

import pytest
from django.utils import timezone

from apps.approvals import services as approvals
from apps.approvals.models import ApprovalLevel, ApprovalMatrix
from apps.authorization.models import ApprovalLimit
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition
from apps.core.models import FeatureFlag
from apps.inventory import documents, selectors
from apps.inventory.models import StockAdjustment, StockCount
from conftest import gl_balance

pytestmark = pytest.mark.django_db
D = Decimal
INV = [
    "inventory.stock_adjustment.create",
    "inventory.stock_adjustment.read",
    "inventory.stock_adjustment.update",
    "inventory.stock_adjustment.post",
]


@pytest.fixture(autouse=True)
def inventory_enabled(db):
    FeatureFlag.objects.create(key="module.inventory", enabled_default=True)


@pytest.fixture
def people(make_user, grant, plant, org, make_role, books):
    keeper, manager = make_user(full_name="Keeper"), make_user(full_name="Manager")
    grant(
        keeper,
        INV
        + [
            "inventory.stock_count.create",
            "inventory.stock_count.update",
            "inventory.stock_transfer.create",
            "inventory.stock_transfer.dispatch",
        ],
        plant["rm"],
    )
    role = make_role(
        [
            "inventory.stock_adjustment.approve",
            "inventory.stock_count.approve",
            "inventory.stock_transfer.receive",
            "inventory.stock_adjustment.read",
        ]
    )
    grant(manager, [], plant["branch"], role=role)
    ApprovalLimit.objects.create(
        organization=org, role=role, document_type="inventory.stock_adjustment", currency="INR", max_amount=D("50000")
    )
    return {"keeper": keeper, "manager": manager, "manager_role": role}


def opening(ctx, keeper_ctx, manager_ctx, books, wh, item, qty="100", cost="20"):
    adj = documents.create_adjustment(
        keeper_ctx,
        company=books,
        warehouse=wh,
        posting_date=timezone.localdate(),
        reason="opening_balance",
        lines=[{"item": item, "quantity": D(qty), "unit_cost": D(cost)}],
    )
    documents.submit_adjustment(keeper_ctx, adj)
    documents.approve_adjustment_directly(manager_ctx, adj)
    return documents.post_adjustment(keeper_ctx, adj)


@pytest.mark.req("INV-009")
def test_adjustment_direct_approval_with_limits_and_no_self_approval(ctx, books, plant, make_item, people, grant):
    item = make_item()
    k, m = ctx(people["keeper"]), ctx(people["manager"])
    adj = documents.create_adjustment(
        k,
        company=books,
        warehouse=plant["rm"],
        posting_date=timezone.localdate(),
        reason="found",
        lines=[{"item": item, "quantity": D("10"), "unit_cost": D("20")}],
    )
    documents.submit_adjustment(k, adj)
    adj.refresh_from_db()
    assert adj.status == "submitted" and adj.amount == D("200.00")
    grant(people["keeper"], [], plant["rm"], role=people["manager_role"])  # keeper now also holds approval role
    with pytest.raises(AuthorizationDenied) as exc:
        documents.approve_adjustment_directly(k, adj)
    assert exc.value.reason == "self_approval"
    with pytest.raises(InvalidStateTransition):
        documents.post_adjustment(k, adj)  # not approved yet
    documents.approve_adjustment_directly(m, adj)
    adj = documents.post_adjustment(k, adj)
    assert adj.status == "posted" and adj.number.startswith("ADJ/")
    assert gl_balance(books, "1300") == D("200") and gl_balance(books, "5120") == D("-200")


def test_adjustment_above_limit_is_denied(ctx, books, plant, make_item, people):
    item = make_item()
    k, m = ctx(people["keeper"]), ctx(people["manager"])
    adj = documents.create_adjustment(
        k,
        company=books,
        warehouse=plant["rm"],
        posting_date=timezone.localdate(),
        reason="found",
        lines=[{"item": item, "quantity": D("1000"), "unit_cost": D("60")}],
    )
    documents.submit_adjustment(k, adj)
    with pytest.raises(AuthorizationDenied) as exc:
        documents.approve_adjustment_directly(m, adj)
    assert exc.value.reason == "approval_limit"


def test_adjustment_through_approval_route(ctx, books, plant, make_item, people, org):
    matrix = ApprovalMatrix.objects.create(organization=org, document_type="inventory.stock_adjustment", name="Adj")
    ApprovalLevel.objects.create(matrix=matrix, sequence=1, name="Warehouse manager", role=people["manager_role"])
    item = make_item()
    k, m = ctx(people["keeper"]), ctx(people["manager"])
    adj = documents.create_adjustment(
        k,
        company=books,
        warehouse=plant["rm"],
        posting_date=timezone.localdate(),
        reason="found",
        lines=[{"item": item, "quantity": D("5"), "unit_cost": D("10")}],
    )
    documents.submit_adjustment(k, adj)
    with pytest.raises(BusinessRuleViolation, match="approval route"):
        documents.approve_adjustment_directly(m, adj)
    request = approvals.inbox(m)[0]
    approvals.decide(m, request, approve=True)
    adj.refresh_from_db()
    assert adj.status == "approved"
    documents.post_adjustment(k, adj)


@pytest.mark.req("INV-008")
def test_two_step_transfer(ctx, books, plant, make_item, people, grant):
    item = make_item()
    k, m = ctx(people["keeper"]), ctx(people["manager"])
    opening(ctx, k, m, books, plant["rm"], item)
    transfer = documents.create_transfer(
        k,
        company=books,
        from_warehouse=plant["rm"],
        to_warehouse=plant["rm2"],
        lines=[{"item": item, "quantity": D("40")}],
    )
    documents.dispatch_transfer(k, transfer, on=timezone.localdate())
    dest = selectors.availability(books.pk, item.pk, plant["rm2"].pk)
    assert dest["in_transit"] == D("40") and dest["available"] == 0
    with pytest.raises(AuthorizationDenied):
        documents.receive_transfer(k, transfer, on=timezone.localdate())  # keeper isn't at the destination
    documents.receive_transfer(m, transfer, on=timezone.localdate())
    assert selectors.availability(books.pk, item.pk, plant["rm2"].pk)["available"] == D("40")
    assert selectors.availability(books.pk, item.pk, plant["rm"].pk)["available"] == D("60")
    assert gl_balance(books, "1300") == D("2000")  # value moved, not created


@pytest.mark.req("INV-010")
def test_count_with_blind_entry_and_independent_approval(ctx, books, plant, make_item, people, make_user, grant):
    item = make_item()
    k, m = ctx(people["keeper"]), ctx(people["manager"])
    opening(ctx, k, m, books, plant["rm"], item, qty="50", cost="10")
    count = documents.start_count(k, company=books, warehouse=plant["rm"], count_date=timezone.localdate())
    line = count.lines.get()
    assert line.system_quantity == D("50")
    with pytest.raises(BusinessRuleViolation, match="needs a count"):
        documents.post_count(m, count)
    # A counter who also holds the approval role still can't approve a count they took part in.
    counter = make_user(full_name="Counter")
    grant(counter, ["inventory.stock_count.update"], plant["rm"])
    grant(counter, [], plant["rm"], role=people["manager_role"])
    documents.record_counts(ctx(counter), count, [{"line_id": line.pk, "counted_quantity": D("47")}])
    with pytest.raises(AuthorizationDenied) as exc:
        documents.post_count(ctx(counter), count)
    assert exc.value.reason == "counter_cannot_approve"
    with pytest.raises(AuthorizationDenied):
        documents.post_count(k, count)  # the person who started the count doesn't hold approval either
    count = documents.post_count(m, count)
    assert count.status == StockCount.Status.POSTED
    assert selectors.availability(books.pk, item.pk, plant["rm"].pk)["on_hand"] == D("47")
    assert gl_balance(books, "5130") == D("30")


def test_adjustment_requires_permission_in_warehouse(ctx, books, plant, make_item, people):
    item = make_item()
    with pytest.raises(AuthorizationDenied):
        documents.create_adjustment(
            ctx(people["keeper"]),
            company=books,
            warehouse=plant["fg"],
            posting_date=timezone.localdate(),
            reason="found",
            lines=[{"item": item, "quantity": D("1")}],
        )
    assert not StockAdjustment.objects.exists()
