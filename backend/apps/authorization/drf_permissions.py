"""DRF permission classes (kept free of rest_framework.views imports to avoid DRF settings import cycles)."""

from django.conf import settings
from rest_framework.exceptions import NotAuthenticated
from rest_framework.permissions import BasePermission

from apps.core.exceptions import AuthorizationDenied, MFARequired

from . import pdp
from .context import actor_for

DEFAULT_VIEWSET_ACTIONS = {
    "list": "read",
    "retrieve": "read",
    "create": "create",
    "update": "update",
    "partial_update": "update",
    "destroy": "delete",
}
DEFAULT_METHOD_ACTIONS = {
    "get": "read",
    "head": "read",
    "options": "read",
    "post": "create",
    "put": "update",
    "patch": "update",
    "delete": "delete",
}

RESTRICTED_ALLOWED = "authz_allow_restricted"


class MFAEnrollmentRequired(AuthorizationDenied):
    type = "mfa_enrollment_required"
    title = "Multi-factor authentication must be set up before continuing."


class PasswordChangeRequired(AuthorizationDenied):
    type = "password_change_required"
    title = "You must change your password before continuing."


def authz_action_for(view, request) -> str | None:
    resource = getattr(view, "authz_resource", None)
    if not resource:
        return None
    overrides = getattr(view, "authz_actions", {}) or {}
    key = getattr(view, "action", None)
    if key is not None:
        verb = overrides.get(key) or DEFAULT_VIEWSET_ACTIONS.get(key)
    else:
        method = request.method.lower()
        verb = overrides.get(method) or DEFAULT_METHOD_ACTIONS.get(method)
    if verb is None:
        return None
    return verb if "." in verb else f"{resource}.{verb}"


class ERPPermission(BasePermission):
    def has_permission(self, request, view) -> bool:
        if getattr(view, "authz_public", False):
            return True
        if not getattr(request.user, "is_authenticated", False):
            raise NotAuthenticated()
        session = request.auth
        reason = getattr(session, "restricted_reason", "")
        if reason and not getattr(view, RESTRICTED_ALLOWED, False):
            raise MFAEnrollmentRequired() if reason == "mfa_enrollment" else PasswordChangeRequired()
        ctx = actor_for(request)
        if getattr(view, "authz_authenticated_only", False):
            return True
        action_map = getattr(view, "action_map", None)
        if action_map is not None and request.method.lower() not in action_map and request.method != "OPTIONS":
            return True  # method not routed on this viewset: DRF answers 405, no handler runs
        action = authz_action_for(view, request)
        if action is None:
            return False  # default deny: view did not declare authorization for this action
        decision = pdp.has_any_grant(ctx, action)
        if not decision.allowed:
            if decision.reason == "mfa_required":
                raise MFARequired()
            return False
        return True

    def has_object_permission(self, request, view, obj) -> bool:
        if getattr(view, "authz_public", False) or getattr(view, "authz_authenticated_only", False):
            return True
        action = authz_action_for(view, request)
        if action is None:
            return False
        pdp.require(actor_for(request), action, pdp.Resource.of(obj))
        return True


class SchemaAccess(BasePermission):
    """OpenAPI schema/docs: public in development, authenticated users otherwise."""

    def has_permission(self, request, view) -> bool:
        if settings.ERP["PUBLIC_SCHEMA"]:
            return True
        return bool(getattr(request.user, "is_authenticated", False)) and not getattr(
            request.auth, "restricted_reason", ""
        )
