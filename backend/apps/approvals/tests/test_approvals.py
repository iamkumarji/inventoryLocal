from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import DatabaseError, transaction
from django.utils import timezone

from apps.approvals import registry, services
from apps.approvals.models import ApprovalLevel, ApprovalMatrix, ApprovalRequest, ApprovalStep
from apps.authorization.models import ApprovalLimit, Permission
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition, VersionConflict
from apps.core.ids import uuid7
from apps.core.models import FeatureFlag
from apps.core.outbox import relay_batch
from apps.notifications.models import Notification

pytestmark = [pytest.mark.django_db, pytest.mark.req("IAM-009")]
DOC = "testdocs.purchase_request"


@pytest.fixture
def doc_type(catalog):
    for action in ("approve", "reject", "create"):
        Permission.objects.create(code=f"{DOC}.{action}", module="testdocs", resource="purchase_request", action=action)
    FeatureFlag.objects.create(key="module.testdocs", enabled_default=True)
    outcomes = []
    registry.register(
        registry.DocumentType(
            code=DOC,
            label="Purchase request",
            on_approved=lambda req, ctx: outcomes.append(("approved", req.document_id)),
            on_rejected=lambda req, ctx: outcomes.append(("rejected", req.document_id)),
            on_withdrawn=lambda req, ctx: outcomes.append(("withdrawn", req.document_id)),
        )
    )
    yield outcomes
    registry.unregister(DOC)


@pytest.fixture
def setup(doc_type, org, company, make_user, make_role, grant, make_branch):
    branch = make_branch(company)
    other_branch = make_branch(company)
    manager_role = make_role([f"{DOC}.approve", f"{DOC}.reject"], code="dept_manager")
    head_role = make_role([f"{DOC}.approve", f"{DOC}.reject"], code="procurement_head")
    escalation_role = make_role(["organization.company.read"], code="director")
    for role, limit in ((manager_role, "100000"), (head_role, "1000000")):
        ApprovalLimit.objects.create(
            organization=org, role=role, document_type=DOC, currency="INR", max_amount=Decimal(limit)
        )
    matrix = ApprovalMatrix.objects.create(organization=org, document_type=DOC, name="PR route")
    ApprovalLevel.objects.create(
        matrix=matrix,
        sequence=1,
        name="Manager",
        role=manager_role,
        escalation_hours=24,
        escalation_role=escalation_role,
    )
    ApprovalLevel.objects.create(
        matrix=matrix, sequence=2, name="Procurement head", role=head_role, min_amount=Decimal("100000.01")
    )
    users = {
        "requester": make_user(full_name="Requester"),
        "manager": make_user(full_name="Manager"),
        "manager_other_branch": make_user(full_name="Other manager"),
        "head": make_user(full_name="Head"),
        "director": make_user(full_name="Director"),
    }
    grant(users["manager"], [], branch, role=manager_role)
    grant(users["manager_other_branch"], [], other_branch, role=manager_role)
    grant(users["head"], [], company, role=head_role)
    grant(users["director"], [], company, role=escalation_role)
    return {"branch": branch, "matrix": matrix, "outcomes": doc_type, **users}


def submit(ctx, setup, company, amount="50000"):
    return services.submit(
        ctx(setup["requester"]),
        document_type=DOC,
        document_id=uuid7(),
        company_id=company.pk,
        title="Bearings for line 2",
        amount=Decimal(amount),
        currency="INR",
        document_number="PR/26-27/000001",
        scope={"branch_id": setup["branch"].pk},
    )


def test_single_level_route_for_small_amount(setup, ctx, company):
    request = submit(ctx, setup, company, "50000")
    assert [s.name for s in request.steps.all()] == ["Manager"]
    assert request.steps.get().is_final
    services.decide(ctx(setup["manager"]), request, approve=True, comment="ok")
    request.refresh_from_db()
    assert request.status == "approved" and setup["outcomes"] == [("approved", request.document_id)]


def test_two_level_route_and_limit_applies_at_final_step(setup, ctx, company):
    request = submit(ctx, setup, company, "250000")
    assert [s.name for s in request.steps.all()] == ["Manager", "Procurement head"]
    # Manager's limit (1 lakh) is below the amount, but intermediate levels endorse.
    services.decide(ctx(setup["manager"]), request, approve=True)
    request.refresh_from_db()
    assert request.status == "pending" and request.current_sequence == 2
    # The manager can't also decide the head's level (and doesn't hold the role anyway).
    with pytest.raises(AuthorizationDenied):
        services.decide(ctx(setup["manager"]), request, approve=True)
    services.decide(ctx(setup["head"]), request, approve=True)
    request.refresh_from_db()
    assert request.status == "approved"


def test_final_step_enforces_approval_limit(setup, ctx, company, org):
    ApprovalLimit.objects.filter(role__code="procurement_head").update(max_amount=Decimal("200000"))
    request = submit(ctx, setup, company, "250000")
    services.decide(ctx(setup["manager"]), request, approve=True)
    with pytest.raises(AuthorizationDenied) as exc:
        services.decide(ctx(setup["head"]), request.__class__.objects.get(pk=request.pk), approve=True)
    assert exc.value.reason == "approval_limit"


def test_requester_cannot_approve_own_request(setup, ctx, company, grant):
    grant(setup["requester"], [], setup["branch"], role=setup["matrix"].levels.get(sequence=1).role)
    request = submit(ctx, setup, company)
    with pytest.raises(AuthorizationDenied):
        services.decide(ctx(setup["requester"]), request, approve=True)
    assert services.inbox(ctx(setup["requester"])) == []


def test_scope_limits_who_can_approve(setup, ctx, company):
    request = submit(ctx, setup, company)
    with pytest.raises(AuthorizationDenied):
        services.decide(ctx(setup["manager_other_branch"]), request, approve=True)
    assert [r.pk for r in services.inbox(ctx(setup["manager"]))] == [request.pk]
    assert services.inbox(ctx(setup["manager_other_branch"])) == []


def test_rejection_requires_reason_and_skips_remaining_steps(setup, ctx, company):
    request = submit(ctx, setup, company, "250000")
    with pytest.raises(Exception, match="reason"):
        services.decide(ctx(setup["manager"]), request, approve=False, comment=" ")
    services.decide(ctx(setup["manager"]), request, approve=False, comment="Use existing stock")
    request.refresh_from_db()
    assert request.status == "rejected"
    assert list(request.steps.values_list("status", flat=True)) == ["rejected", "skipped"]
    assert setup["outcomes"] == [("rejected", request.document_id)]
    with pytest.raises(InvalidStateTransition):
        services.decide(ctx(setup["head"]), request, approve=True)


def test_mfa_required_for_decisions_when_permission_requires_it(setup, ctx, company):
    Permission.objects.filter(code=f"{DOC}.approve").update(requires_mfa=True)
    request = submit(ctx, setup, company)
    with pytest.raises(AuthorizationDenied) as exc:
        services.decide(ctx(setup["manager"], mfa=False), request, approve=True)
    assert exc.value.reason == "mfa_required"


def test_delegation_acts_with_delegator_authority(setup, ctx, company, make_user):
    delegate = make_user(full_name="Deputy")
    now = timezone.now()
    services.create_delegation(
        ctx(setup["manager"]),
        delegate=delegate,
        valid_from=now - timedelta(minutes=1),
        valid_until=now + timedelta(days=7),
        reason="Leave",
        document_types=[DOC],
    )
    request = submit(ctx, setup, company)
    assert [r.pk for r in services.inbox(ctx(delegate))] == [request.pk]
    services.decide(ctx(delegate), request, approve=True)
    step = ApprovalStep.objects.get(request=request)
    assert step.decided_by == delegate and step.acting_for == setup["manager"]


def test_delegate_cannot_approve_own_request(setup, ctx, company):
    now = timezone.now()
    services.create_delegation(
        ctx(setup["manager"]),
        delegate=setup["requester"],
        valid_from=now,
        valid_until=now + timedelta(days=1),
        reason="Leave",
    )
    request = submit(ctx, setup, company)
    with pytest.raises(AuthorizationDenied):
        services.decide(ctx(setup["requester"]), request, approve=True)


def test_expired_or_revoked_delegation_grants_nothing(setup, ctx, company, make_user):
    delegate = make_user()
    now = timezone.now()
    delegation = services.create_delegation(
        ctx(setup["manager"]), delegate=delegate, valid_from=now, valid_until=now + timedelta(days=1), reason="Leave"
    )
    services.revoke_delegation(ctx(setup["manager"]), delegation)
    request = submit(ctx, setup, company)
    with pytest.raises(AuthorizationDenied):
        services.decide(ctx(delegate), request, approve=True)


def test_withdraw_only_by_requester(setup, ctx, company):
    request = submit(ctx, setup, company)
    with pytest.raises(AuthorizationDenied):
        services.withdraw(ctx(setup["manager"]), request)
    services.withdraw(ctx(setup["requester"]), request, reason="Wrong vendor")
    request.refresh_from_db()
    assert request.status == "withdrawn" and setup["outcomes"] == [("withdrawn", request.document_id)]


def test_submission_rules(setup, ctx, company):
    request = submit(ctx, setup, company)
    with pytest.raises(BusinessRuleViolation, match="already pending"):
        services.submit(
            ctx(setup["requester"]),
            document_type=DOC,
            document_id=request.document_id,
            company_id=company.pk,
            title="dup",
            amount=Decimal("1"),
        )
    with pytest.raises(BusinessRuleViolation) as exc:
        services.submit(
            ctx(setup["requester"]),
            document_type="unknown.thing",
            document_id=uuid7(),
            company_id=company.pk,
            title="x",
        )
    assert exc.value.code == "unknown_document_type"
    setup["matrix"].is_active = False
    setup["matrix"].save()
    with pytest.raises(BusinessRuleViolation) as exc:
        submit(ctx, setup, company)
    assert exc.value.code == "no_approval_route"


def test_version_conflict_and_decided_steps_are_frozen(setup, ctx, company):
    request = submit(ctx, setup, company)
    with pytest.raises(VersionConflict):
        services.decide(ctx(setup["manager"]), request, approve=True, expected_version=99)
    services.decide(ctx(setup["manager"]), request, approve=True, expected_version=1)
    step = ApprovalStep.objects.get(request=request)
    with pytest.raises(DatabaseError, match="immutable_record"), transaction.atomic():
        ApprovalStep.objects.filter(pk=step.pk).update(comment="rewritten history")


def test_notifications_flow_through_outbox(setup, ctx, company):
    request = submit(ctx, setup, company, "250000")
    relay_batch()
    assert Notification.objects.filter(recipient=setup["manager"], category="approval").count() == 1
    assert not Notification.objects.filter(recipient=setup["head"]).exists()  # not their step yet
    services.decide(ctx(setup["manager"]), request, approve=True)
    relay_batch()
    assert Notification.objects.filter(recipient=setup["head"]).count() == 1
    services.decide(ctx(setup["head"]), ApprovalRequest.objects.get(pk=request.pk), approve=True)
    relay_batch()
    outcome = Notification.objects.get(recipient=setup["requester"])
    assert outcome.title.endswith("approved") and outcome.link == f"/approvals/{request.pk}"


def test_escalation_of_overdue_step(setup, ctx, company):
    request = submit(ctx, setup, company)
    relay_batch()
    assert services.escalate_overdue(timezone.now() + timedelta(hours=23)) == 0
    assert services.escalate_overdue(timezone.now() + timedelta(hours=25)) == 1
    assert services.escalate_overdue(timezone.now() + timedelta(hours=26)) == 0  # only once
    relay_batch()
    assert Notification.objects.filter(recipient=setup["director"], title__startswith="Overdue").exists()
    assert ApprovalStep.objects.get(request=request).escalated_at is not None


# --- API -----------------------------------------------------------------------------------------


def test_api_inbox_decide_and_visibility(setup, ctx, company, api_for, make_user):
    request = submit(ctx, setup, company)
    manager = api_for(setup["manager"])
    inbox = manager.get("/api/v1/approvals/inbox/").json()
    assert [r["id"] for r in inbox] == [str(request.pk)] and inbox[0]["can_decide"] is True
    assert manager.get("/api/v1/approvals/inbox/count/").json() == {"count": 1}

    url = f"/api/v1/approvals/requests/{request.pk}/approve/"
    missing_key = manager.post(url, {"version": 1}, format="json")
    assert missing_key.status_code == 400
    ok = manager.post(url, {"version": 1, "comment": "Fine"}, format="json", HTTP_IDEMPOTENCY_KEY="dec-1")
    assert ok.status_code == 200, ok.json()
    assert ok.json()["status"] == "approved" and ok.json()["steps"][0]["decided_by"]["full_name"] == "Manager"
    replay = manager.post(url, {"version": 1, "comment": "Fine"}, format="json", HTTP_IDEMPOTENCY_KEY="dec-1")
    assert replay.status_code == 200 and replay["Idempotent-Replayed"] == "true"

    requester = api_for(setup["requester"])
    mine = requester.get("/api/v1/approvals/requests/?mine=1").json()["results"]
    assert [r["id"] for r in mine] == [str(request.pk)]
    outsider = api_for(make_user())
    assert outsider.get(f"/api/v1/approvals/requests/{request.pk}/").status_code == 404


def test_api_matrix_admin(setup, api_for, make_user, grant, org):
    admin = make_user()
    grant(admin, ["approvals.approval_matrix.read", "approvals.approval_matrix.manage"], org)
    client = api_for(admin)
    role_id = str(setup["matrix"].levels.get(sequence=1).role_id)
    created = client.post(
        "/api/v1/approvals/matrices/",
        {
            "document_type": DOC,
            "company": str(setup["branch"].company_id),
            "name": "Company route",
            "levels": [{"sequence": 1, "name": "Manager", "role": role_id, "min_amount": "0"}],
        },
        format="json",
    )
    assert created.status_code == 201, created.json()
    bad = client.post(
        "/api/v1/approvals/matrices/", {"document_type": "nope.nope", "name": "x", "levels": []}, format="json"
    )
    assert bad.status_code == 400
    updated = client.patch(
        f"/api/v1/approvals/matrices/{created.json()['id']}/",
        {
            "version": 1,
            "levels": [
                {"sequence": 1, "name": "Manager", "role": role_id},
                {"sequence": 2, "name": "Head", "role": role_id, "min_amount": "500000"},
            ],
        },
        format="json",
    )
    assert updated.status_code == 200 and len(updated.json()["levels"]) == 2
    assert api_for(admin, mfa=False).post("/api/v1/approvals/matrices/", {}, format="json").status_code == 403
