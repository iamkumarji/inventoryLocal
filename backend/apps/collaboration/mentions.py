"""Mention parsing: `@user@example.com` or `@[<user uuid>]`."""

from __future__ import annotations

import re
from uuid import UUID

from apps.identity.models import User

EMAIL_MENTION = re.compile(r"(?<![\w@])@([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
ID_MENTION = re.compile(r"@\[([0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})\]")
MAX_MENTIONS = 50


def parse(body: str) -> tuple[set[str], set[UUID]]:
    emails = {m.rstrip(".").lower() for m in EMAIL_MENTION.findall(body or "")}
    ids = {UUID(m) for m in ID_MENTION.findall(body or "")}
    return emails, ids


def resolve_users(body: str, organization_id) -> list[User]:
    """Active users of the author's organization referenced in `body` (unknown references are ignored)."""
    emails, ids = parse(body)
    if not emails and not ids:
        return []
    by_email = User.objects.filter(email__in=emails) if emails else User.objects.none()
    by_id = User.objects.filter(pk__in=ids) if ids else User.objects.none()
    users = (by_email | by_id).filter(is_active=True, organization_id=organization_id).distinct()
    return list(users.order_by("email")[:MAX_MENTIONS])
