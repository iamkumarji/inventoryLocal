"""Builds the ActorContext for an API request, including the active company."""

from uuid import UUID

from apps.core.context import ActorContext, current_request_id
from apps.core.exceptions import AuthorizationDenied
from apps.core.net import client_ip

from .snapshot import get_snapshot

COMPANY_HEADER = "HTTP_X_COMPANY_ID"


def actor_for(request) -> ActorContext:
    cached = getattr(request, "_erp_actor", None)
    if cached is not None:
        return cached
    user = getattr(request, "user", None)
    session = getattr(request, "auth", None)
    user = user if getattr(user, "is_authenticated", False) else None
    company_id = None
    if user is not None:
        companies = get_snapshot(user.pk).companies
        raw = request.META.get(COMPANY_HEADER, "").strip()
        if raw:
            try:
                company_id = UUID(raw)
            except ValueError as exc:
                raise AuthorizationDenied("invalid_company_header") from exc
            if company_id not in companies:
                raise AuthorizationDenied("company_not_accessible")
        elif user.default_company_id in companies:
            company_id = user.default_company_id
        elif len(companies) == 1:
            company_id = next(iter(companies))
    ctx = ActorContext(
        user=user,
        company_id=company_id,
        request_id=getattr(request, "request_id", None) or current_request_id(),
        ip=client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", "")[:300],
        client_type=getattr(session, "client_type", "web") if session else "anonymous",
        session_id=getattr(session, "pk", None),
        mfa_verified_at=getattr(session, "mfa_verified_at", None),
    )
    request._erp_actor = ctx
    return ctx
