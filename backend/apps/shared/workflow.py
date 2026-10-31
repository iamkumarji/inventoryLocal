"""Approval workflow shared by approvable documents.

Documents expose `status`, `submitted_by`, `approved_by`, `version`, `amount`, `currency`.
On submit, a configured approval route (approvals engine) takes over; without a route a single
approver decides directly, still subject to the PDP (limits, self-approval, SoD).
"""

from __future__ import annotations

from django.db import transaction

from apps.approvals import registry
from apps.approvals import services as approvals
from apps.approvals.models import ApprovalRequest
from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import BusinessRuleViolation, InvalidStateTransition, VersionConflict
from apps.organization.models import Company


def check(doc, expected_version, *statuses):
    if expected_version is not None and doc.version != expected_version:
        raise VersionConflict()
    if statuses and doc.status not in statuses:
        raise InvalidStateTransition(f"Not allowed while the document is {doc.status}.")


def bump(doc, ctx: ActorContext, **changes):
    for key, value in changes.items():
        setattr(doc, key, value)
    doc.version += 1
    if hasattr(doc, "updated_by_id"):
        doc.updated_by = ctx.user
    doc.save()
    return doc


@transaction.atomic
def submit(
    ctx: ActorContext,
    doc,
    *,
    document_type: str,
    title: str,
    summary: dict | None = None,
    scope: dict | None = None,
    expected_version=None,
    from_statuses=("draft", "rejected"),
):
    doc = type(doc).objects.select_for_update().get(pk=doc.pk)
    check(doc, expected_version, *from_statuses)
    pdp.require(ctx, f"{document_type}.update", pdp.Resource.of(doc))
    bump(doc, ctx, status="submitted", submitted_by=ctx.user, approved_by=None)
    # The document's organization, not the actor's: system contexts (imports, schedules) have no user.
    organization_id = Company.objects.filter(pk=doc.company_id).values_list("organization_id", flat=True).first()
    if approvals.resolve_matrix(organization_id, doc.company_id, document_type):
        approvals.submit(
            ctx,
            document_type=document_type,
            document_id=doc.pk,
            company_id=doc.company_id,
            title=title,
            amount=getattr(doc, "amount", None),
            currency=getattr(doc, "currency", "INR"),
            document_number=getattr(doc, "number", ""),
            summary=summary or {},
            scope=scope or {},
        )
    audit.record(
        f"{document_type}.submitted",
        ctx=ctx,
        resource_type=document_type,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=title,
    )
    return doc


@transaction.atomic
def decide_directly(
    ctx: ActorContext, doc, *, document_type: str, approve: bool, comment: str = "", expected_version=None
):
    doc = type(doc).objects.select_for_update().get(pk=doc.pk)
    check(doc, expected_version, "submitted")
    if ApprovalRequest.objects.filter(
        document_type=document_type, document_id=doc.pk, status=ApprovalRequest.Status.PENDING
    ).exists():
        raise BusinessRuleViolation(
            "This document follows an approval route. Decide it in Approvals.", code="approval_route_active"
        )
    pdp.require(ctx, f"{document_type}.{'approve' if approve else 'reject'}", pdp.Resource.of(doc))
    bump(doc, ctx, status="approved" if approve else "rejected", approved_by=ctx.user if approve else None)
    audit.record(
        f"{document_type}.{'approved' if approve else 'rejected'}",
        ctx=ctx,
        resource_type=document_type,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=comment[:500],
    )
    return doc


def register(document_type: str, model, label: str, link_prefix: str, on_approved=None):
    """Register a document type with the approvals engine: outcomes set the document status."""

    def approved(request, ctx):
        doc = model.objects.select_for_update().get(pk=request.document_id)
        bump(doc, ctx, status="approved", approved_by=ctx.user)
        if on_approved:
            on_approved(doc, ctx)

    def rejected(request, ctx):
        doc = model.objects.select_for_update().get(pk=request.document_id)
        bump(doc, ctx, status="rejected")

    def withdrawn(request, ctx):
        doc = model.objects.select_for_update().get(pk=request.document_id)
        bump(doc, ctx, status="draft")

    registry.register(
        registry.DocumentType(
            code=document_type,
            label=label,
            on_approved=approved,
            on_rejected=rejected,
            on_withdrawn=withdrawn,
            link=lambda r: f"{link_prefix}/{r.document_id}",
        )
    )
