from datetime import timedelta

import pytest
from django.utils import timezone

from apps.authorization.models import AbacPolicy
from apps.authorization.templates import POLICY_TEMPLATES
from apps.collaboration import services
from apps.collaboration import tasks as celery_tasks
from apps.collaboration.models import EscalationRule, Task, TaskEscalation
from apps.core.exceptions import AuthorizationDenied
from apps.notifications.models import Notification

pytestmark = pytest.mark.django_db
URL = "/api/v1/collaboration/tasks/"
TASK_PERMS = ["collaboration.task.create", "collaboration.task.read", "collaboration.task.update"]


@pytest.fixture
def own_tasks_policy(org):
    tpl = next(p for p in POLICY_TEMPLATES if p["code"] == "allow_own_tasks")
    return AbacPolicy.objects.create(organization=org, **{k: v for k, v in tpl.items()})


@pytest.fixture
def manager(make_user, grant, company):
    user = make_user(full_name="Mona Manager")
    grant(user, [*TASK_PERMS, "collaboration.task.assign", "organization.department.read"], company)
    return user


@pytest.fixture
def worker(make_user, grant, company):
    """An employee: may create tasks but has no task update grant (own tasks come from the ABAC policy)."""
    user = make_user(full_name="Wasim Worker")
    grant(user, ["collaboration.task.create"], company)
    return user


def test_create_and_assign_notifies_assignee(manager, worker, api_for, ref):
    due = (timezone.now() + timedelta(days=1)).isoformat()
    response = api_for(manager).post(
        URL, {"title": "Calibrate gauges", "assignee": str(worker.pk), "due_at": due, **ref}, format="json"
    )
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["assignee"] == str(worker.pk)
    assert body["resource_type"] == "organization.department"
    note = Notification.objects.get(recipient=worker)
    assert note.category == "task"
    assert note.title == "Task assigned to you: Calibrate gauges"


def test_assigning_requires_assign_permission(make_user, grant, company, worker, api_for):
    creator = make_user()
    grant(creator, TASK_PERMS, company)
    client = api_for(creator)
    assert client.post(URL, {"title": "x", "assignee": str(worker.pk)}, format="json").status_code == 403
    task = client.post(URL, {"title": "x"}, format="json").json()
    assigned = client.post(f"{URL}{task['id']}/assign/", {"assignee": str(worker.pk), "version": 1}, format="json")
    assert assigned.status_code == 403


def test_linking_an_unreadable_record_is_404(worker, api_for, ref):
    assert api_for(worker).post(URL, {"title": "x", **ref}, format="json").status_code == 404


def test_assignee_updates_own_task_via_policy(
    manager, worker, api_for, own_tasks_policy, make_user, grant, company, ctx
):
    task = api_for(manager).post(URL, {"title": "Count bins", "assignee": str(worker.pk)}, format="json").json()
    mine = api_for(worker).get("/api/v1/collaboration/my-tasks/")
    assert [t["id"] for t in mine.json()["results"]] == [task["id"]]
    moved = api_for(worker).post(
        f"/api/v1/collaboration/my-tasks/{task['id']}/transition/",
        {"status": "in_progress", "version": task["version"]},
        format="json",
    )
    assert moved.status_code == 200, moved.content
    assert moved.json()["status"] == "in_progress"
    done = api_for(worker).post(
        f"/api/v1/collaboration/my-tasks/{task['id']}/transition/",
        {"status": "done", "version": moved.json()["version"]},
        format="json",
    )
    assert done.json()["status"] == "done"
    assert Notification.objects.filter(recipient=manager, title="Task completed: Count bins").exists()

    stranger = make_user()
    grant(stranger, ["collaboration.task.create"], company)
    assert api_for(stranger).get(f"/api/v1/collaboration/my-tasks/{task['id']}/").status_code == 404
    with pytest.raises(AuthorizationDenied):
        services.transition_task(ctx(stranger), Task.objects.get(pk=task["id"]), "open", done.json()["version"])


def test_without_policy_assignee_cannot_update(manager, worker, api_for):
    task = api_for(manager).post(URL, {"title": "Count bins", "assignee": str(worker.pk)}, format="json").json()
    moved = api_for(worker).post(
        f"/api/v1/collaboration/my-tasks/{task['id']}/transition/", {"status": "done", "version": 1}, format="json"
    )
    assert moved.status_code == 403


def test_update_uses_optimistic_locking_and_state_machine(manager, api_for):
    client = api_for(manager)
    task = client.post(URL, {"title": "Draft"}, format="json").json()
    path = f"{URL}{task['id']}/"
    assert client.patch(path, {"title": "Final", "version": 1}, format="json").json()["title"] == "Final"
    assert client.patch(path, {"title": "Stale", "version": 1}, format="json").status_code == 409
    assert client.post(f"{path}transition/", {"status": "cancelled", "version": 2}, format="json").status_code == 200
    assert client.post(f"{path}transition/", {"status": "done", "version": 3}, format="json").status_code == 409


# --- Escalation ------------------------------------------------------------------------------------


@pytest.fixture
def overdue_task(manager, worker, ctx, make_department, company):
    dept = make_department(company, code="MAINT")
    task = services.create_task(ctx(manager), title="Fix boiler", assignee=worker, department=dept)
    Task.objects.filter(pk=task.pk).update(due_at=timezone.now() - timedelta(hours=3))
    return Task.objects.get(pk=task.pk)


def test_escalation_to_role_holders_is_idempotent(overdue_task, company, make_role, grant, make_user):
    supervisor_role = make_role(["collaboration.task.read"], code="supervisor")
    supervisor = make_user(full_name="Sam Supervisor")
    grant(supervisor, [], company, role=supervisor_role)
    rule = EscalationRule.objects.create(
        company=company, code="R2H", name="2h overdue", overdue_hours=2, target="role", role=supervisor_role
    )
    later = EscalationRule.objects.create(
        company=company, code="R6H", name="6h overdue", overdue_hours=6, target="role", role=supervisor_role
    )
    now = timezone.now()
    assert services.escalate_overdue_tasks(now) == 1
    assert services.escalate_overdue_tasks(now) == 0
    assert celery_tasks.escalate_overdue_tasks.delay(now.isoformat()).get() == 0
    overdue_task.refresh_from_db()
    assert overdue_task.escalated_at == now
    assert overdue_task.escalation_count == 1
    assert Notification.objects.filter(recipient=supervisor, title="Overdue task: Fix boiler").count() == 1
    assert TaskEscalation.objects.get().rule == rule

    assert services.escalate_overdue_tasks(now + timedelta(hours=4)) == 1  # second level, once
    assert services.escalate_overdue_tasks(now + timedelta(hours=5)) == 0
    assert set(TaskEscalation.objects.values_list("rule_id", flat=True)) == {rule.pk, later.pk}


def test_escalation_to_department_head_skips_recipients_without_access(overdue_task, company, make_user, grant, ctx):
    head = make_user(full_name="Head")
    grant(head, ["collaboration.task.read"], overdue_task.department)
    overdue_task.department.head_user = head
    overdue_task.department.save()
    EscalationRule.objects.create(company=company, code="HEAD", name="Head", overdue_hours=1, target="department_head")
    assert services.escalate_overdue_tasks() == 1
    assert Notification.objects.filter(recipient=head, category="task", severity="warning").count() == 1

    # A head without read access to the task is not told about it.
    overdue_task.refresh_from_db()
    blind = make_user()
    overdue_task.department.head_user = blind
    overdue_task.department.save()
    services.update_task(
        ctx(overdue_task.created_by),
        overdue_task,
        {"due_at": timezone.now() - timedelta(hours=2)},
        overdue_task.version,
    )
    assert TaskEscalation.objects.count() == 0  # new deadline resets escalation
    assert services.escalate_overdue_tasks() == 1
    assert not Notification.objects.filter(recipient=blind).exists()
    assert TaskEscalation.objects.get().recipients == 0


def test_done_tasks_do_not_escalate(overdue_task, company, ctx, manager):
    EscalationRule.objects.create(company=company, code="A", name="A", overdue_hours=1, target="assignee")
    services.transition_task(ctx(manager), overdue_task, "done", overdue_task.version)
    assert services.escalate_overdue_tasks() == 0
