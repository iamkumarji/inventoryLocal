"""Every write the mobile app queues offline must be replay-safe (NFR-010): the endpoint honours the
Idempotency-Key header, so a resend after a lost response returns the stored result instead of
acting twice. Keep this list in step with mobile/src/lib/operations.ts."""

import pytest
from django.urls import resolve

MOBILE_WRITES = [
    ("post", "/api/v1/procurement/receipts/", "create"),
    ("post", "/api/v1/procurement/receipts/00000000-0000-0000-0000-000000000000/post/", "post_document"),
    ("post", "/api/v1/inventory/counts/00000000-0000-0000-0000-000000000000/record/", "record"),
    ("post", "/api/v1/inventory/transfers/00000000-0000-0000-0000-000000000000/receive/", "receive"),
    ("post", "/api/v1/logistics/shipments/00000000-0000-0000-0000-000000000000/proof/", "proof"),
    ("post", "/api/v1/documents/documents/", "create"),
    ("post", "/api/v1/expenses/claims/", "create"),
    ("post", "/api/v1/expenses/claims/00000000-0000-0000-0000-000000000000/submit/", "submit"),
    ("post", "/api/v1/approvals/requests/00000000-0000-0000-0000-000000000000/approve/", "approve"),
    ("post", "/api/v1/approvals/requests/00000000-0000-0000-0000-000000000000/reject/", "reject"),
]


@pytest.mark.req("NFR-010")
@pytest.mark.parametrize(("method", "path", "action"), MOBILE_WRITES)
def test_mobile_writes_are_idempotent(method, path, action):
    match = resolve(path)
    view_cls = match.func.cls
    handler_name = match.func.actions[method] if hasattr(match.func, "actions") else method
    assert handler_name == action
    assert getattr(getattr(view_cls, handler_name), "idempotent", False), f"{path} ignores Idempotency-Key"


@pytest.mark.django_db
@pytest.mark.req("ADM-004")
def test_admin_can_switch_a_module_on(make_user, grant, org, api_for):
    from apps.core import flags
    from apps.core.models import FeatureFlag

    flag = FeatureFlag.objects.create(key="module.inventory", enabled_default=False)
    admin, viewer = make_user(), make_user()
    grant(admin, ["core.feature_flag.read", "core.feature_flag.manage"], org)
    grant(viewer, ["core.feature_flag.read"], org)
    url = f"/api/v1/admin/feature-flags/{flag.pk}/"
    assert api_for(viewer).patch(url, {"enabled_default": True}, format="json").status_code == 403
    assert not flags.is_enabled("module.inventory", organization_id=org.pk)
    response = api_for(admin).patch(url, {"enabled_default": True}, format="json")
    assert response.status_code == 200, response.content
    # Effective immediately, for the admin's own organization only (the platform default is unchanged).
    assert flags.is_enabled("module.inventory", organization_id=org.pk)
    assert not flags.is_enabled("module.inventory")
