"""DEVELOPMENT-ONLY demo document type for exercising the approval engine and UI.

Registered only when settings.ERP["DEMO_DATA"] is true and DEBUG is on. It runs through
the real approval services; nothing here bypasses authorization. Real document types
(purchase requisitions, purchase orders, payments, expense claims) arrive with their modules.
"""

from django.conf import settings

from apps.authorization.registry import resource_permissions

DOCUMENT_TYPE = "demo.purchase_request"


def enabled() -> bool:
    return bool(settings.DEBUG and settings.ERP.get("DEMO_DATA"))


def permissions():
    if not enabled():
        return []
    return resource_permissions(DOCUMENT_TYPE, ["read", "create", "approve", "reject"], "DEMO purchase requests")


def register() -> None:
    if not enabled():
        return
    from . import registry

    registry.register(registry.DocumentType(code=DOCUMENT_TYPE, label="DEMO purchase request"))
