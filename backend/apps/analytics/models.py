from django.db import models

from apps.core.models import CompanyScopedModel


class ReportJob(CompanyScopedModel):
    """An export generated in the background. Only the requester can download it, and only while they
    still hold the export permission it was generated under."""

    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        DONE = "done"
        FAILED = "failed"

    report_type = models.CharField(max_length=40)
    params = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.QUEUED)
    # The requester's session facts, so the worker evaluates policies exactly as the request would have.
    mfa_verified_at = models.DateTimeField(null=True, blank=True)
    client_type = models.CharField(max_length=20, default="web")
    requested_ip = models.GenericIPAddressField(null=True, blank=True)
    row_count = models.PositiveIntegerField(default=0)
    result_csv = models.TextField(blank=True)
    error = models.CharField(max_length=500, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField()

    authz_resource_type = "analytics.report"
    # Jobs are personal: visibility is the requester only (enforced in the view and services), so no
    # org-scope matching applies; company isolation still does through the company_id attribute.
    authz_scope_fields: dict = {}

    class Meta:
        db_table = "analytics_report_jobs"
        indexes = [models.Index(fields=["created_by", "-created_at"], name="ix_report_job_owner")]
