"""Request/actor context passed explicitly into services.

`ActorContext` is the subject of every authorization decision and audit event.
Contextvars carry the request ID into logs and events for code that has no
request object (Celery tasks set it themselves).
"""

from __future__ import annotations

import contextvars
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from django.utils import timezone

from .ids import uuid7

if TYPE_CHECKING:
    from apps.identity.models import User

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
user_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("user_id", default=None)


def new_request_id() -> str:
    return uuid7().hex


def current_request_id() -> str:
    return request_id_var.get() or new_request_id()


@dataclass(frozen=True)
class ActorContext:
    user: User | None
    company_id: UUID | None = None
    request_id: str = field(default_factory=current_request_id)
    ip: str | None = None
    user_agent: str = ""
    client_type: str = "system"
    session_id: UUID | None = None
    mfa_verified_at: datetime | None = None
    is_system: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def user_id(self) -> UUID | None:
        return self.user.pk if self.user is not None else None

    @classmethod
    def system(cls, reason: str, company_id: UUID | None = None) -> ActorContext:
        return cls(user=None, company_id=company_id, client_type="system", is_system=True, extra={"reason": reason})

    def with_company(self, company_id: UUID | None) -> ActorContext:
        return replace(self, company_id=company_id)

    def mfa_verified_within(self, minutes: int) -> bool:
        if self.mfa_verified_at is None:
            return False
        return (timezone.now() - self.mfa_verified_at).total_seconds() <= minutes * 60
