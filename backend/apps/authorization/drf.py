"""DRF integration of the PDP.

Every view must declare one of:
  authz_public = True              unauthenticated endpoints (login, health)
  authz_authenticated_only = True  self-service endpoints acting on the caller only
  authz_resource = "<module>.<resource>"  + optional authz_actions overrides
Anything else is denied (default deny). A test walks the URL conf to prove it.
"""

from rest_framework import mixins, viewsets
from rest_framework.relations import PrimaryKeyRelatedField

from . import pdp
from .context import actor_for
from .drf_permissions import (  # noqa: F401 - re-exported for views
    ERPPermission,
    MFAEnrollmentRequired,
    PasswordChangeRequired,
    SchemaAccess,
    authz_action_for,
)


class ERPViewMixin:
    """Common behaviour: actor context and scope-filtered querysets (out of scope -> 404)."""

    authz_resource: str | None = None
    authz_actions: dict[str, str] = {}
    authz_queryset_action = "read"

    @property
    def actor(self):
        return actor_for(self.request)

    def get_queryset(self):
        queryset = super().get_queryset()
        if getattr(self, "swagger_fake_view", False):
            return queryset.none()
        action = f"{self.authz_resource}.{self.authz_queryset_action}"
        return pdp.filter_queryset(self.actor, action, queryset)


class ERPGenericViewSet(ERPViewMixin, viewsets.GenericViewSet):
    pass


class ERPReadOnlyViewSet(ERPViewMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    pass


class ScopedPrimaryKeyRelatedField(PrimaryKeyRelatedField):
    """FK input limited to rows the caller can read, so out-of-scope IDs are rejected as 'does not exist'."""

    def __init__(self, *args, read_action: str | None = None, **kwargs):
        self.read_action = read_action
        super().__init__(*args, **kwargs)

    def get_queryset(self):
        queryset = super().get_queryset()
        request = self.context.get("request")
        if request is None:
            return queryset.none()
        action = self.read_action or f"{queryset.model.authz_resource_type}.read"
        return pdp.filter_queryset(actor_for(request), action, queryset)
