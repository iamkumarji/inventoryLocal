import csv
import io
import logging
from dataclasses import replace
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation

from .models import ReportJob
from .reports import REPORTS, may_export

logger = logging.getLogger("erp.analytics")
RETENTION = timedelta(days=7)
MAX_PENDING_PER_USER = 5


def request_report(ctx: ActorContext, *, company_id, report_type: str, params: dict) -> ReportJob:
    report = REPORTS.get(report_type)
    if report is None:
        raise ValidationError({"report_type": ["Unknown report."]})
    if not pdp.has_any_grant(ctx, "analytics.report.create").allowed:
        raise AuthorizationDenied(reason="no_grant")
    if not may_export(ctx, report, company_id):
        raise AuthorizationDenied(reason="no_grant")
    missing = [p for p in report.params if not params.get(p)]
    if missing:
        raise ValidationError({"params": [f"Missing: {', '.join(missing)}."]})
    pending = ReportJob.objects.filter(created_by=ctx.user, status__in=("queued", "running")).count()
    if pending >= MAX_PENDING_PER_USER:
        raise BusinessRuleViolation("Wait for your earlier exports to finish.", code="too_many_exports")
    job = ReportJob.objects.create(
        company_id=company_id,
        report_type=report_type,
        params={k: str(params[k]) for k in report.params},
        mfa_verified_at=ctx.mfa_verified_at,
        client_type=ctx.client_type[:20],
        requested_ip=ctx.ip,
        expires_at=timezone.now() + RETENTION,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        "analytics.report.requested",
        ctx=ctx,
        resource_type="analytics.report",
        resource_id=job.pk,
        company_id=company_id,
        summary=report.label,
        changes={"report_type": report_type, "params": job.params},
    )
    from .tasks import generate_report

    transaction.on_commit(lambda: generate_report.delay(str(job.pk)))
    return job


def _to_csv(rows: list[dict]) -> str:
    out = io.StringIO()
    if rows:
        columns = list(dict.fromkeys(key for row in rows for key in row))
        writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            # Neutralise spreadsheet formulas in text cells (CSV injection).
            writer.writerow(
                {k: f"'{v}" if isinstance(v, str) and v[:1] in ("=", "+", "-", "@") else v for k, v in row.items()}
            )
    return out.getvalue()


def run_report(job_id) -> ReportJob:
    with transaction.atomic():
        job = ReportJob.objects.select_for_update(of=("self",)).select_related("created_by").get(pk=job_id)
        if job.status != ReportJob.Status.QUEUED:
            return job
        job.status, job.started_at = ReportJob.Status.RUNNING, timezone.now()
        job.save(update_fields=["status", "started_at"])
    report = REPORTS[job.report_type]
    # Run with the requester's own authority, re-checked now: revoked access stops the export.
    ctx = ActorContext(
        user=job.created_by,
        company_id=job.company_id,
        client_type=job.client_type,
        ip=job.requested_ip,
        mfa_verified_at=job.mfa_verified_at,
    )
    try:
        if not may_export(ctx, report, job.company_id):
            raise AuthorizationDenied(reason="no_grant")
        rows = report.rows(ctx, job.company_id, job.params)
        job.result_csv, job.row_count, job.status = _to_csv(rows), len(rows), ReportJob.Status.DONE
    except AuthorizationDenied:
        job.status, job.error = ReportJob.Status.FAILED, "You no longer have permission to export this report."
    except Exception as exc:  # report failures are recorded on the job, not raised into the worker
        logger.exception("report generation failed", extra={"job_id": str(job.pk)})
        job.status, job.error = ReportJob.Status.FAILED, str(exc)[:500] or exc.__class__.__name__
    job.finished_at = timezone.now()
    job.save(update_fields=["result_csv", "row_count", "status", "error", "finished_at"])
    return job


def download(ctx: ActorContext, job: ReportJob) -> str:
    if job.created_by_id != ctx.user_id:
        raise AuthorizationDenied(reason="not_owner")
    if job.status != ReportJob.Status.DONE or job.expires_at <= timezone.now():
        raise BusinessRuleViolation("This export isn't available.", code="export_unavailable")
    if not may_export(replace(ctx, company_id=job.company_id), REPORTS[job.report_type], job.company_id):
        raise AuthorizationDenied(reason="no_grant")
    audit.record(
        "analytics.report.downloaded",
        ctx=ctx,
        resource_type="analytics.report",
        resource_id=job.pk,
        company_id=job.company_id,
        summary=f"{job.report_type} ({job.row_count} rows)",
    )
    return job.result_csv


def purge_expired() -> int:
    deleted, _ = ReportJob.objects.filter(expires_at__lte=timezone.now()).delete()
    return deleted
