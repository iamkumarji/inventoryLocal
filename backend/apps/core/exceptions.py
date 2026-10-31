"""Domain exceptions and the API error contract (docs/API_SPECIFICATION.md §3)."""

import logging
from typing import Any

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError, IntegrityError
from django.http import Http404
from rest_framework import exceptions as drf_exceptions
from rest_framework import status
from rest_framework.response import Response

from .context import current_request_id

logger = logging.getLogger("erp.errors")


class DomainError(Exception):
    status_code = status.HTTP_400_BAD_REQUEST
    type = "domain_error"
    title = "Request could not be processed."

    def __init__(self, detail: str | None = None, *, code: str | None = None, meta: dict | None = None):
        self.detail = detail or self.title
        self.code = code or self.type
        self.meta = meta or {}
        super().__init__(self.detail)


class BusinessRuleViolation(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    type = "business_rule_violation"
    title = "Business rule violated."


class InvalidStateTransition(DomainError):
    status_code = status.HTTP_409_CONFLICT
    type = "invalid_state_transition"
    title = "This action is not allowed in the current state."


class VersionConflict(DomainError):
    status_code = status.HTTP_409_CONFLICT
    type = "version_conflict"
    title = "The record was changed by someone else. Reload and try again."


class NotFound(DomainError):
    status_code = status.HTTP_404_NOT_FOUND
    type = "not_found"
    title = "Not found."


class FeatureDisabled(DomainError):
    status_code = status.HTTP_404_NOT_FOUND
    type = "feature_disabled"
    title = "This feature is not enabled."


class AuthorizationDenied(DomainError):
    """Raised by the PDP. The specific reason is logged, never returned (except mfa_required)."""

    status_code = status.HTTP_403_FORBIDDEN
    type = "permission_denied"
    title = "You do not have permission to perform this action."

    def __init__(self, reason: str = "no_grant", detail: str | None = None):
        self.reason = reason
        super().__init__(detail)


class MFARequired(AuthorizationDenied):
    type = "mfa_required"
    title = "Multi-factor verification is required for this action."

    def __init__(self, detail: str | None = None):
        super().__init__(reason="mfa_required", detail=detail)


class AccountLocked(DomainError):
    status_code = status.HTTP_403_FORBIDDEN
    type = "account_locked"
    title = "Account is temporarily locked. Try again later."


class AuthenticationFailedError(DomainError):
    status_code = status.HTTP_401_UNAUTHORIZED
    type = "authentication_failed"
    title = "Invalid credentials."


class IdempotencyKeyReused(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    type = "idempotency_key_reused"
    title = "Idempotency-Key was already used with a different request."


class IdempotencyInProgress(DomainError):
    status_code = status.HTTP_409_CONFLICT
    type = "idempotency_in_progress"
    title = "A request with this Idempotency-Key is still being processed."


class ImmutableRecord(DomainError):
    status_code = status.HTTP_409_CONFLICT
    type = "immutable_record"
    title = "Posted records cannot be changed. Create a reversal or adjustment instead."


def _flatten_errors(detail: Any, prefix: str = "") -> list[dict]:
    errors: list[dict] = []
    if isinstance(detail, dict):
        for key, value in detail.items():
            if key == "non_field_errors":
                path = prefix
            elif prefix:
                path = f"{prefix}.{key}"
            else:
                path = str(key)
            errors.extend(_flatten_errors(value, path))
    elif isinstance(detail, list):
        for index, item in enumerate(detail):
            if isinstance(item, (dict, list)):
                errors.extend(_flatten_errors(item, f"{prefix}[{index}]"))
            else:
                errors.extend(_flatten_errors(item, prefix))
    else:
        code = getattr(detail, "code", "invalid")
        errors.append({"field": prefix or None, "code": code, "message": str(detail)})
    return errors


def _problem(status_code: int, type_: str, title: str, detail: str, **extra) -> Response:
    body = {"type": type_, "title": title, "status": status_code, "detail": detail, "request_id": current_request_id()}
    body.update({k: v for k, v in extra.items() if v is not None})
    return Response(body, status=status_code)


_DRF_TYPES = {
    drf_exceptions.NotAuthenticated: "not_authenticated",
    drf_exceptions.AuthenticationFailed: "authentication_failed",
    drf_exceptions.PermissionDenied: "permission_denied",
    drf_exceptions.NotFound: "not_found",
    drf_exceptions.MethodNotAllowed: "method_not_allowed",
    drf_exceptions.NotAcceptable: "not_acceptable",
    drf_exceptions.UnsupportedMediaType: "unsupported_media_type",
    drf_exceptions.Throttled: "throttled",
    drf_exceptions.ParseError: "parse_error",
}


# Denial reasons that describe a control on the caller's own action. Others (no_grant, policy,
# company mismatch) stay generic so responses never reveal what exists or how policies are written.
EXPLAINED_DENIALS = {
    "self_approval": "You can't approve or decide something you created or submitted.",
    "maker_checker": "Another person must check this: you entered or prepared it.",
    "approval_limit": "The amount is above your approval limit.",
    "sod": "This would combine duties that must stay with different people.",
}


def api_exception_handler(exc: Exception, context: dict) -> Response | None:
    if isinstance(exc, DomainError):
        if isinstance(exc, AuthorizationDenied):
            logger.info("authorization denied", extra={"reason": exc.reason})
            explained = EXPLAINED_DENIALS.get(exc.reason)
            if explained:
                # Controls on the caller's own action (they can already see the record): safe to say which.
                return _problem(exc.status_code, exc.type, exc.title, explained, code=exc.reason)
        code = exc.code if exc.code != exc.type else None
        return _problem(exc.status_code, exc.type, exc.title, exc.detail, code=code, meta=exc.meta or None)

    if isinstance(exc, DjangoValidationError):
        exc = drf_exceptions.ValidationError(detail=exc.message_dict if hasattr(exc, "error_dict") else exc.messages)
    elif isinstance(exc, Http404):
        exc = drf_exceptions.NotFound()
    elif isinstance(exc, DjangoPermissionDenied):
        exc = drf_exceptions.PermissionDenied()
    elif isinstance(exc, DatabaseError) and "immutable_record" in str(exc):  # raised by DB triggers
        return _problem(409, ImmutableRecord.type, ImmutableRecord.title, ImmutableRecord.title)
    elif isinstance(exc, IntegrityError):
        logger.warning("integrity error", extra={"error": str(exc).splitlines()[0]})
        return _problem(409, "conflict", "Conflict with existing data.", "The change conflicts with existing data.")

    if isinstance(exc, drf_exceptions.ValidationError):
        return _problem(
            400,
            "validation_error",
            "Invalid input.",
            "One or more fields failed validation.",
            errors=_flatten_errors(exc.detail),
        )

    from rest_framework.views import exception_handler as drf_default_handler  # deferred: avoids import cycle

    response = drf_default_handler(exc, context)
    if response is None:
        logger.exception("unhandled error", exc_info=exc)
        return _problem(500, "server_error", "Server error.", "An unexpected error occurred.")

    type_ = next((t for cls, t in _DRF_TYPES.items() if isinstance(exc, cls)), "error")
    detail = exc.detail if isinstance(getattr(exc, "detail", None), str) else str(getattr(exc, "detail", ""))
    problem = _problem(response.status_code, type_, detail, detail)
    for header in ("WWW-Authenticate", "Retry-After", "Allow"):
        if header in response:
            problem[header] = response[header]
    return problem
