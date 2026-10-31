import logging

from celery import shared_task

from .services import seal_pending, verify_chain

logger = logging.getLogger("erp.audit")


@shared_task(name="apps.audit.tasks.seal_audit_chain", ignore_result=True)
def seal_audit_chain() -> int:
    total = 0
    while (count := seal_pending()) > 0:
        total += count
    return total


@shared_task(name="apps.audit.tasks.verify_audit_chain")
def verify_audit_chain() -> dict:
    result = verify_chain()
    if not result["valid"]:
        logger.critical("audit chain verification failed", extra=result)
    return result
