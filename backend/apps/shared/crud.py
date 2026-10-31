"""Generic, authorized and audited CRUD for master data.

Business documents (orders, receipts, journals) have their own services with state
machines; this layer is only for reference data with simple lifecycles.
"""

from __future__ import annotations

from django.db import IntegrityError, transaction
from django.db.models import Model
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import VersionConflict


def _fields(model: type[Model], names) -> tuple[str, ...]:
    concrete = {f.name for f in model._meta.concrete_fields}
    return tuple(n for n in names if n in concrete)


def _integrity_message(exc: IntegrityError, unique_field: str, unique_message: str) -> dict:
    """Map a database constraint failure to a field error without exposing SQL."""
    diag = getattr(getattr(exc, "__cause__", None), "diag", None)
    constraint = getattr(diag, "constraint_name", "") or ""
    sqlstate = getattr(getattr(exc, "__cause__", None), "sqlstate", "") or ""
    if sqlstate == "23505" or constraint.startswith("uq_"):  # unique violation
        return {unique_field: [unique_message]}
    if constraint.startswith("ck_"):
        readable = constraint.removeprefix("ck_").replace("_", " ")
        return {"_form": [f"The values break a data rule ({readable})."]}
    return {"_form": ["The change conflicts with existing data."]}


def create_record(
    ctx: ActorContext, model: type[Model], data: dict, *, resource: pdp.Resource, audit_fields=None
) -> Model:
    pdp.require(ctx, f"{model.authz_resource_type}.create", resource)
    instance = model(**data)
    if hasattr(instance, "created_by_id"):
        instance.created_by = ctx.user
        instance.updated_by = ctx.user
    try:
        with transaction.atomic():
            instance.full_clean(validate_unique=False, validate_constraints=False, exclude=["created_by", "updated_by"])
            instance.save()
    except IntegrityError as exc:
        raise ValidationError(_integrity_message(exc, "code", "A record with this code already exists.")) from exc
    fields = _fields(model, audit_fields or data.keys())
    audit.record(
        f"{model.authz_resource_type}.created",
        ctx=ctx,
        resource_type=model.authz_resource_type,
        resource_id=instance.pk,
        company_id=getattr(instance, "company_id", None),
        changes={"after": audit.snapshot(instance, fields)},
    )
    return instance


@transaction.atomic
def update_record(
    ctx: ActorContext,
    instance: Model,
    data: dict,
    expected_version: int | None,
    editable: tuple[str, ...],
    action: str = "update",
) -> Model:
    model = type(instance)
    instance = model.objects.select_for_update().get(pk=instance.pk)
    pdp.require(ctx, f"{model.authz_resource_type}.{action}", pdp.Resource.of(instance))
    if hasattr(instance, "version") and (expected_version is None or instance.version != expected_version):
        raise VersionConflict()
    unknown = set(data) - set(editable)
    if unknown:
        raise ValidationError({field: ["This field cannot be changed."] for field in sorted(unknown)})
    fields = _fields(model, editable)
    before = audit.snapshot(instance, fields)
    for key, value in data.items():
        setattr(instance, key, value)
    if hasattr(instance, "version"):
        instance.version += 1
    if hasattr(instance, "updated_by_id"):
        instance.updated_by = ctx.user
    instance.full_clean(validate_unique=False, validate_constraints=False, exclude=["created_by", "updated_by"])
    try:
        with transaction.atomic():
            instance.save()
    except IntegrityError as exc:
        raise ValidationError(_integrity_message(exc, "_form", "The change conflicts with existing data.")) from exc
    changes = audit.diff(before, audit.snapshot(instance, fields))
    if changes:
        audit.record(
            f"{model.authz_resource_type}.updated",
            ctx=ctx,
            resource_type=model.authz_resource_type,
            resource_id=instance.pk,
            company_id=getattr(instance, "company_id", None),
            changes=changes,
        )
    return instance
