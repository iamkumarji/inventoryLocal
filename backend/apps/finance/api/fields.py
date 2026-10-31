"""Foreign-key inputs limited to the caller's own books.

A related id is accepted only if the record belongs to the caller's active company (or, for organization-wide
records such as partners, to the caller's organization). Anything else reads as "does not exist", so another
tenant's ids can't be referenced and their existence isn't revealed.

The scope is stricter than the generic organization boundary (apps.authorization.tenancy) and spells out each
model's path, so it starts from the field's own queryset instead of the generic guess (which, for example,
places a journal line by its optional warehouse and so drops lines that have none).
"""

from rest_framework import serializers

from apps.authorization.context import actor_for


class TenantPrimaryKeyRelatedField(serializers.PrimaryKeyRelatedField):
    def __init__(
        self, *args, company_path: str | None = "company_id", org_path: str = "company__organization_id", **kw
    ):
        self.company_path = company_path
        self.org_path = org_path
        super().__init__(*args, **kw)

    def get_queryset(self):
        queryset = self.queryset.all()
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if request is None or not getattr(user, "is_authenticated", False) or not user.organization_id:
            return queryset.none()
        queryset = queryset.filter(**{self.org_path: user.organization_id})
        company_id = actor_for(request).company_id if self.company_path else None
        return queryset.filter(**{self.company_path: company_id}) if company_id else queryset


def company_pk(queryset, path: str = "company_id", **kw) -> TenantPrimaryKeyRelatedField:
    """A record owned by one company (accounts, bank accounts, open items...): the caller's active company."""
    org_path = path.removesuffix("_id") + "__organization_id"
    return TenantPrimaryKeyRelatedField(queryset=queryset, company_path=path, org_path=org_path, **kw)


def organization_pk(queryset, **kw) -> TenantPrimaryKeyRelatedField:
    """An organization-wide record (partners): the caller's organization."""
    return TenantPrimaryKeyRelatedField(queryset=queryset, company_path=None, org_path="organization_id", **kw)
