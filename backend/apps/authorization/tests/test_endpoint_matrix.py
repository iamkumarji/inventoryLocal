"""Authorization matrix (docs/RBAC_ABAC.md §11).

Walks every URL under /api/v1/ and proves:
1. every view explicitly declares how it is authorized (no accidental open endpoint);
2. anonymous callers get 401 on everything that isn't explicitly public;
3. an authenticated user with no roles is denied on every resource endpoint.
"""

import re
import uuid

import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

PUBLIC_PATHS = {"/api/v1/auth/login/", "/api/v1/auth/login/mfa/"}
SCHEMA_PATHS = {"/api/v1/schema/", "/api/v1/docs/", "/api/v1/redoc/"}


def _walk(patterns, prefix=""):
    for p in patterns:
        if isinstance(p, URLResolver):
            yield from _walk(p.url_patterns, prefix + str(p.pattern))
        elif isinstance(p, URLPattern):
            yield prefix + str(p.pattern), p


def _concrete(route: str) -> str:
    path = route.replace("^", "").replace("$", "").replace("\\.", ".")
    path = re.sub(r"\(\?P<format>[^)]*\)", "", path)
    path = re.sub(r"\(\?P<[^>]+>[^)]*\)", str(uuid.uuid4()), path)
    path = re.sub(r"<[^>]+>", str(uuid.uuid4()), path)
    return "/" + path.lstrip("/")


def api_endpoints():
    seen = set()
    for route, pattern in _walk(get_resolver().url_patterns):
        if not route.lstrip("^").startswith("api/v1/") or ".(?P<format>" in route or "\\.(?P<format>" in route:
            continue
        path = _concrete(route)
        if path in seen:
            continue
        seen.add(path)
        view_class = getattr(pattern.callback, "cls", None)
        actions = getattr(pattern.callback, "actions", None)
        methods = sorted(actions) if actions else ["get", "post", "put", "patch", "delete"]
        yield path, view_class, methods


ENDPOINTS = list(api_endpoints())


def test_matrix_covers_endpoints():
    assert len(ENDPOINTS) > 30


@pytest.mark.parametrize(("path", "view_class", "methods"), ENDPOINTS, ids=[e[0] for e in ENDPOINTS])
def test_every_view_declares_authorization(path, view_class, methods):
    if path in SCHEMA_PATHS:
        return
    assert view_class is not None, f"{path} is not a DRF view"
    declared = (
        getattr(view_class, "authz_public", False)
        or getattr(view_class, "authz_authenticated_only", False)
        or getattr(view_class, "authz_resource", None)
    )
    assert declared, f"{path} ({view_class.__name__}) declares no authorization"
    if getattr(view_class, "authz_public", False):
        assert path in PUBLIC_PATHS, f"{path} is public but not in the reviewed public allow-list"


@pytest.mark.parametrize(("path", "view_class", "methods"), ENDPOINTS, ids=[e[0] for e in ENDPOINTS])
def test_anonymous_is_rejected(path, view_class, methods, settings):
    if path in PUBLIC_PATHS or path in SCHEMA_PATHS:
        return
    client = APIClient()
    for method in methods:
        response = getattr(client, method)(path, {}, format="json")
        assert response.status_code in (401, 405), f"{method.upper()} {path} -> {response.status_code}"


@pytest.mark.parametrize(("path", "view_class", "methods"), ENDPOINTS, ids=[e[0] for e in ENDPOINTS])
def test_user_without_roles_is_denied(path, view_class, methods, make_user, api_for, catalog):
    if path in PUBLIC_PATHS or path in SCHEMA_PATHS or getattr(view_class, "authz_authenticated_only", False):
        return
    client = api_for(make_user())
    for method in methods:
        response = getattr(client, method)(path, {}, format="json")
        assert response.status_code in (403, 404, 405), f"{method.upper()} {path} -> {response.status_code}"


def test_schema_requires_auth_outside_development(settings, make_user, api_for):
    settings.ERP = {**settings.ERP, "PUBLIC_SCHEMA": False}
    assert APIClient().get("/api/v1/schema/").status_code in (401, 403)
    assert api_for(make_user()).get("/api/v1/schema/").status_code == 200
