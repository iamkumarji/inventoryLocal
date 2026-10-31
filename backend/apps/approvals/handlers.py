"""Side effects of approval events (async via the outbox): notifications only."""

from apps.core.outbox import register_handler
from apps.notifications.models import Category, Notification
from apps.notifications.services import notify

from . import registry
from .models import ApprovalRequest
from .services import current_step, eligible_users, users_with_role_in_scope


def _link(request: ApprovalRequest) -> str:
    doc_type = registry.get(request.document_type)
    if doc_type and doc_type.link:
        return doc_type.link(request)
    return f"/approvals/{request.pk}"


def _label(request: ApprovalRequest) -> str:
    doc_type = registry.get(request.document_type)
    number = f" {request.document_number}" if request.document_number else ""
    return f"{doc_type.label if doc_type else request.document_type}{number}"


def _notify_current_approvers(request: ApprovalRequest, event_id) -> None:
    step = current_step(request)
    if step is None:
        return
    notify(
        eligible_users(request, step),
        category=Category.APPROVAL,
        title=f"Approval needed: {_label(request)}",
        body=f"{request.title} — step '{step.name}', requested by {request.requested_by.full_name}.",
        link=_link(request),
        resource_type="approvals.approval_request",
        resource_id=request.pk,
        dedupe_key=f"approval:{request.pk}:step:{step.sequence}",
        company_id=request.company_id,
    )


@register_handler("approvals.request.submitted", name="approvals.notify_submitted")
@register_handler("approvals.step.approved", name="approvals.notify_next_step")
def notify_approvers(event) -> None:
    request = ApprovalRequest.objects.select_related("requested_by").filter(pk=event.aggregate_id).first()
    if request is not None and request.status == ApprovalRequest.Status.PENDING:
        _notify_current_approvers(request, event.pk)


@register_handler("approvals.request.approved", name="approvals.notify_outcome_approved")
@register_handler("approvals.request.rejected", name="approvals.notify_outcome_rejected")
def notify_requester(event) -> None:
    request = ApprovalRequest.objects.select_related("requested_by").filter(pk=event.aggregate_id).first()
    if request is None:
        return
    approved = request.status == ApprovalRequest.Status.APPROVED
    notify(
        [request.requested_by],
        category=Category.APPROVAL,
        title=f"{_label(request)} {'approved' if approved else 'rejected'}",
        body=request.title,
        link=_link(request),
        resource_type="approvals.approval_request",
        resource_id=request.pk,
        severity=Notification.Severity.INFO if approved else Notification.Severity.WARNING,
        dedupe_key=f"approval:{request.pk}:outcome",
        company_id=request.company_id,
    )


@register_handler("approvals.step.escalated", name="approvals.notify_escalation")
def notify_escalation(event) -> None:
    request = ApprovalRequest.objects.select_related("requested_by").filter(pk=event.aggregate_id).first()
    if request is None or request.status != ApprovalRequest.Status.PENDING:
        return
    step = current_step(request)
    if step is None:
        return
    recipients = list(eligible_users(request, step))
    if step.escalation_role_id:
        recipients += users_with_role_in_scope(step.escalation_role, request)
    notify(
        recipients,
        category=Category.APPROVAL,
        severity=Notification.Severity.WARNING,
        title=f"Overdue approval: {_label(request)}",
        body=f"Step '{step.name}' has passed its deadline.",
        link=_link(request),
        resource_type="approvals.approval_request",
        resource_id=request.pk,
        dedupe_key=f"approval:{request.pk}:step:{step.sequence}:escalated",
        company_id=request.company_id,
    )
