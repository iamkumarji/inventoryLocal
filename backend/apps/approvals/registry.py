"""Document types that can be routed for approval.

The owning module registers its type at app-ready time. Completion callbacks run
synchronously inside the decision transaction, so the document's status changes
atomically with the approval outcome (never through the async outbox).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from apps.core.context import ActorContext

    from .models import ApprovalRequest

Callback = Callable[["ApprovalRequest", "ActorContext"], None]


@dataclass(frozen=True)
class DocumentType:
    code: str  # equals the permission resource, e.g. "procurement.purchase_order"
    label: str
    on_approved: Callback | None = None
    on_rejected: Callback | None = None
    on_withdrawn: Callback | None = None
    link: Callable[[ApprovalRequest], str] | None = None


_registry: dict[str, DocumentType] = {}


def register(document_type: DocumentType) -> None:
    _registry[document_type.code] = document_type


def unregister(code: str) -> None:
    _registry.pop(code, None)


def get(code: str) -> DocumentType | None:
    return _registry.get(code)


def all_types() -> list[DocumentType]:
    return sorted(_registry.values(), key=lambda d: d.code)
