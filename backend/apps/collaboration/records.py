"""Generic business-record references: `(resource_type, resource_id)` -> model instance, with authorization
delegated to the target record.

Any concrete model whose class attribute `authz_resource_type` equals the string is a candidate (several
models may share a type, e.g. RFQs and supplier quotations). Access requires `<resource_type>.read` on the
record. Unknown types, unknown IDs and records the caller may not read all raise `NotFound`, so the
existence of out-of-scope records never leaks.

A model may define `authz_record_read_check(ctx)` to add checks beyond the PDP (documents use it to
enforce confidentiality ACLs); it raises `AuthorizationDenied` to refuse.
"""

from __future__ import annotations

import re
from collections import defaultdict
from functools import lru_cache
from uuid import UUID

from django.apps import apps
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Model
from django.utils import timezone

from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, MFARequired, NotFound

RESOURCE_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")
# Types that are never valid targets of a reference (no comments on comments).
NON_TARGET_TYPES = frozenset({"collaboration.comment"})


@lru_cache(maxsize=1)
def registry() -> dict[str, tuple[type[Model], ...]]:
    found: dict[str, list[type[Model]]] = defaultdict(list)
    for model in apps.get_models():
        rtype = getattr(model, "authz_resource_type", "")
        if not isinstance(rtype, str) or not rtype or rtype in NON_TARGET_TYPES:
            continue
        if model._meta.abstract or model._meta.proxy or not hasattr(model, "authz_attributes"):
            continue
        found[rtype].append(model)
    return {rtype: tuple(models) for rtype, models in found.items()}


def _load(resource_type: str, resource_id) -> Model:
    models = registry().get(resource_type) if RESOURCE_TYPE_RE.match(resource_type or "") else None
    if not models:
        raise NotFound("Record not found.", code="record_not_found")
    for model in models:
        try:
            instance = model._default_manager.filter(pk=resource_id).first()
        except (DjangoValidationError, ValueError, TypeError):
            continue
        if instance is not None:
            return instance
    raise NotFound("Record not found.", code="record_not_found")


def _check(ctx: ActorContext, resource_type: str, instance: Model) -> None:
    pdp.require(ctx, f"{resource_type}.read", pdp.Resource.of(instance))
    extra = getattr(instance, "authz_record_read_check", None)
    if callable(extra):
        extra(ctx)


def resolve(ctx: ActorContext, resource_type: str, resource_id) -> Model:
    """Load the record and require read access to it. Out of scope -> NotFound."""
    instance = _load(resource_type, resource_id)
    try:
        _check(ctx, resource_type, instance)
    except MFARequired:
        raise
    except AuthorizationDenied:
        raise NotFound("Record not found.", code="record_not_found") from None
    return instance


def record_company_id(instance: Model) -> UUID | None:
    return instance.authz_attributes().get("company_id")


def entitlement_ctx(user, company_id: UUID | None) -> ActorContext:
    """Context for "could this other user read X?" checks (notification eligibility).

    Evaluates entitlements, not session state: MFA is treated as satisfied because the recipient still
    has to pass the PDP (including MFA) when actually opening the record.
    """
    return ActorContext(
        user=user,
        company_id=company_id if company_id is not None else user.default_company_id,
        client_type="system",
        mfa_verified_at=timezone.now(),
    )


def user_can_read(user, resource_type: str, instance: Model) -> bool:
    if user is None or not user.is_active:
        return False
    ctx = entitlement_ctx(user, record_company_id(instance))
    try:
        _check(ctx, resource_type, instance)
    except AuthorizationDenied:
        return False
    return True
