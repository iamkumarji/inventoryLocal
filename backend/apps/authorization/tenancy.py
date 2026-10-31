"""Tenant boundary for references in API input.

Lists and detail views are already bounded by grants (which never cross an organization). This closes
the other door: a request naming another organization's record by id in its body (an item on a PO, a
supplier, an account). Every DRF related field resolves ids only within the caller's organization.

Each model is placed in an organization through the first path found:
  organization_id → company → branch/warehouse/facility/department → its parent document (one FK hop
  to a model that itself has a path). Models with no path are platform-wide (the permission catalogue).
"""

from __future__ import annotations

from functools import cache

from django.db import models
from rest_framework.relations import RelatedField

DIRECT = (
    ("organization", "organization_id"),
    ("company", "company__organization_id"),
    ("branch", "branch__company__organization_id"),
    ("warehouse", "warehouse__company__organization_id"),
    ("facility", "facility__branch__company__organization_id"),
    ("department", "department__company__organization_id"),
)


def _direct(model, *, required_only: bool = True) -> str | None:
    """Path through the model's own organization/company/... field. Optional ones (a journal line's
    warehouse) can't place a row in an organization -- NULL drops it from the join -- so by default they
    are skipped in favour of a required parent."""
    if model._meta.label_lower == "organization.organization":
        return "pk"
    fields = {f.name: f for f in model._meta.concrete_fields}
    for name, path in DIRECT:
        field = fields.get(name)
        if field is not None and (not required_only or name == "organization" or not field.null):
            return path
    return None


@cache
def organization_path(model) -> str | None:
    path = _direct(model)
    if path is not None:
        return path
    # Lines and other children: follow the first required FK to a parent that has a required path.
    for field in model._meta.concrete_fields:
        if isinstance(field, models.ForeignKey) and not field.null:
            parent = _direct(field.related_model)
            if parent is not None:
                return field.name if parent == "pk" else f"{field.name}__{parent}"
    # Last resort: an optional direct field (rows without it then can't be referenced).
    return _direct(model, required_only=False)


def restrict(queryset, organization_id):
    path = organization_path(queryset.model)
    if path is None or organization_id is None:
        return queryset
    return queryset.filter(**{path: organization_id})


_original_get_queryset = RelatedField.get_queryset


def _tenant_get_queryset(self):
    queryset = _original_get_queryset(self)
    if not isinstance(queryset, models.QuerySet):
        return queryset
    try:
        request = self.context.get("request")
    except AttributeError:  # unbound field (schema generation)
        request = None
    user = getattr(request, "user", None)
    if user is None or not getattr(user, "is_authenticated", False):
        return queryset
    org_id = getattr(user, "organization_id", None)
    if org_id is None:
        # Platform operators belong to no organization and may not reference tenant records.
        return queryset.none() if organization_path(queryset.model) else queryset
    return restrict(queryset, org_id)


def install() -> None:
    RelatedField.get_queryset = _tenant_get_queryset
