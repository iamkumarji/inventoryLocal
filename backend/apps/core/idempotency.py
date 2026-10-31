"""Idempotency-Key support for critical write endpoints (API spec §5).

Flow:
1. Claim the key in its own committed transaction (status in_progress). A
   concurrent duplicate hits the unique constraint and sees in_progress -> 409.
2. Run the view and store the response inside ONE transaction, so the business
   change and the stored response commit (or roll back) together.
3. On failure the claim is deleted so the client may retry with the same key.
"""

import hashlib
import json
from datetime import timedelta
from functools import wraps

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response

from .exceptions import IdempotencyInProgress, IdempotencyKeyReused
from .models import IdempotencyKey

HEADER = "Idempotency-Key"


def _fingerprint(request) -> str:
    body = request.data if hasattr(request, "data") else {}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    raw = f"{request.method}\n{request.path}\n{canonical}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _claim(user, key: str, request, fingerprint: str) -> tuple[IdempotencyKey | None, Response | None]:
    now = timezone.now()
    ttl = timedelta(hours=settings.ERP["IDEMPOTENCY_TTL_HOURS"])
    for _ in range(2):
        try:
            with transaction.atomic():
                record = IdempotencyKey.objects.create(
                    user=user,
                    key=key,
                    method=request.method,
                    path=request.path[:512],
                    request_hash=fingerprint,
                    expires_at=now + ttl,
                )
            return record, None
        except IntegrityError:
            existing = IdempotencyKey.objects.filter(user=user, key=key).first()
            if existing is None:
                continue
            if existing.expires_at <= now:
                existing.delete()
                continue
            if existing.request_hash != fingerprint:
                raise IdempotencyKeyReused()
            if existing.status == IdempotencyKey.Status.IN_PROGRESS:
                raise IdempotencyInProgress()
            replay = Response(existing.response_body, status=existing.response_status)
            replay["Idempotent-Replayed"] = "true"
            return None, replay
    raise IdempotencyInProgress()


def idempotent(required: bool = False):
    """Decorator for DRF view handler methods (post/put/patch or @action methods)."""

    def decorator(handler):
        @wraps(handler)
        def wrapper(view, request, *args, **kwargs):
            key = request.headers.get(HEADER, "").strip()
            if not key:
                if required:
                    raise ValidationError({HEADER: ["This header is required for this operation."]})
                return handler(view, request, *args, **kwargs)
            if len(key) > 255:
                raise ValidationError({HEADER: ["Must be at most 255 characters."]})

            record, replay = _claim(request.user, key, request, _fingerprint(request))
            if replay is not None:
                return replay
            try:
                with transaction.atomic():
                    response = handler(view, request, *args, **kwargs)
                    if response.status_code < 500:
                        body = json.loads(JSONRenderer().render(response.data)) if response.data is not None else None
                        record.status = IdempotencyKey.Status.COMPLETED
                        record.response_status = response.status_code
                        record.response_body = body
                        record.save(update_fields=["status", "response_status", "response_body"])
            except BaseException:
                IdempotencyKey.objects.filter(pk=record.pk).delete()
                raise
            if response.status_code >= 500:
                IdempotencyKey.objects.filter(pk=record.pk).delete()
            return response

        wrapper.idempotent = True
        wrapper.idempotency_required = required
        return wrapper

    return decorator


def idempotency_header(required: bool = False):
    """OpenAPI description of the Idempotency-Key header for @extend_schema(parameters=[...])."""
    from drf_spectacular.utils import OpenApiParameter

    return OpenApiParameter(
        HEADER,
        str,
        OpenApiParameter.HEADER,
        required=required,
        description="Unique per user action; a retry with the same key replays the stored response.",
    )
