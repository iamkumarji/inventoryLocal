from celery import shared_task

from .services import escalate_overdue


@shared_task(name="apps.approvals.tasks.escalate_overdue_approvals", ignore_result=True)
def escalate_overdue_approvals() -> int:
    return escalate_overdue()
