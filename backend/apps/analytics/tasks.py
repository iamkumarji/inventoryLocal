from celery import shared_task

from . import services


@shared_task(name="apps.analytics.tasks.generate_report", ignore_result=True)
def generate_report(job_id: str) -> None:
    services.run_report(job_id)


@shared_task(name="apps.analytics.tasks.purge_expired_reports", ignore_result=True)
def purge_expired_reports() -> int:
    return services.purge_expired()
