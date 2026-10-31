"""Audit recording, hash chain sealing and verification (docs/RBAC_ABAC.md §10)."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

from django.core.serializers.json import DjangoJSONEncoder
from django.db import connection, transaction
from django.db.models import Model
from django.utils import timezone

from apps.core.context import ActorContext, current_request_id

from .models import AuditChainSeal, AuditEvent

MASK = "***"
GENESIS_HASH = "0" * 64
_SEAL_LOCK_KEY = 0x45525041554454  # arbitrary advisory-lock key ("ERPAUDT")


def _json_roundtrip(value: Any) -> Any:
    return json.loads(json.dumps(value, cls=DjangoJSONEncoder))


def _canonical(event: AuditEvent) -> str:
    data = {
        "id": str(event.id),
        "occurred_at": event.occurred_at.isoformat(),
        "organization_id": str(event.organization_id) if event.organization_id else None,
        "company_id": str(event.company_id) if event.company_id else None,
        "actor_id": str(event.actor_id) if event.actor_id else None,
        "actor_type": event.actor_type,
        "action": event.action,
        "resource_type": event.resource_type,
        "resource_id": event.resource_id,
        "summary": event.summary,
        "changes": event.changes,
        "outcome": event.outcome,
        "request_id": event.request_id,
        "ip": event.ip,
    }
    return json.dumps(data, sort_keys=True, separators=(",", ":"), cls=DjangoJSONEncoder)


def compute_content_hash(event: AuditEvent) -> str:
    return hashlib.sha256(_canonical(event).encode()).hexdigest()


def record(
    action: str,
    *,
    ctx: ActorContext | None = None,
    resource_type: str = "",
    resource_id: Any = "",
    company_id=None,
    organization_id=None,
    summary: str = "",
    changes: dict | None = None,
    outcome: str = AuditEvent.Outcome.SUCCESS,
    actor_id=None,
    actor_label: str = "",
) -> AuditEvent:
    """Append an audit event in the current transaction.

    Business events roll back with their transaction (nothing happened). Security
    events that must survive a failing request are recorded outside an atomic block.
    """
    user = ctx.user if ctx else None
    if user is not None:
        actor_type, actor_id = AuditEvent.ActorType.USER, user.pk
        actor_label = actor_label or user.email
        organization_id = organization_id or getattr(user, "organization_id", None)
    elif ctx is not None and ctx.is_system:
        actor_type = AuditEvent.ActorType.SYSTEM
        actor_label = actor_label or ctx.extra.get("reason", "system")
    else:
        actor_type = AuditEvent.ActorType.ANONYMOUS if actor_id is None else AuditEvent.ActorType.USER
    event = AuditEvent(
        occurred_at=timezone.now(),
        organization_id=organization_id,
        company_id=company_id if company_id is not None else (ctx.company_id if ctx else None),
        actor_id=actor_id,
        actor_type=actor_type,
        actor_label=actor_label[:254],
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id or "")[:64],
        summary=summary[:500],
        changes=_json_roundtrip(changes or {}),
        outcome=outcome,
        request_id=(ctx.request_id if ctx else current_request_id())[:64],
        ip=ctx.ip if ctx else None,
        user_agent=(ctx.user_agent if ctx else "")[:300],
    )
    event.content_hash = compute_content_hash(event)
    event.save(force_insert=True)
    return event


def snapshot(instance: Model, fields: Iterable[str]) -> dict:
    data = {}
    for name in fields:
        field = instance._meta.get_field(name)
        data[name] = getattr(instance, field.attname)
    return _json_roundtrip(data)


def diff(before: dict, after: dict, sensitive: Iterable[str] = ()) -> dict:
    sensitive = set(sensitive)
    changes = {}
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key), after.get(key)
        if old != new:
            changes[key] = {"from": MASK, "to": MASK} if key in sensitive else {"from": old, "to": new}
    return changes


def seal_pending(batch_size: int = 1000) -> int:
    """Chain unsealed events in commit order. Single writer via advisory lock."""
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [_SEAL_LOCK_KEY])
            if not cursor.fetchone()[0]:
                return 0
        last = AuditChainSeal.objects.order_by("-seq").first()
        prev_hash, seq = (last.chain_hash, last.seq) if last else (GENESIS_HASH, 0)
        pending = list(AuditEvent.objects.filter(seal__isnull=True).order_by("occurred_at", "id")[:batch_size])
        seals = []
        for event in pending:
            seq += 1
            chain_hash = hashlib.sha256(f"{prev_hash}{event.content_hash}".encode()).hexdigest()
            seals.append(AuditChainSeal(seq=seq, event=event, prev_hash=prev_hash, chain_hash=chain_hash))
            prev_hash = chain_hash
        AuditChainSeal.objects.bulk_create(seals)
        return len(seals)


def verify_chain(limit: int | None = None) -> dict:
    """Recompute content and chain hashes. Returns the first problem found, if any."""
    prev_hash, checked = GENESIS_HASH, 0
    seals = AuditChainSeal.objects.select_related("event").order_by("seq")
    if limit:
        seals = seals[:limit]
    expected_seq = 1
    for seal in seals.iterator(chunk_size=2000):
        if seal.seq != expected_seq:
            return {"valid": False, "checked": checked, "problem": "sequence_gap", "seq": expected_seq}
        if seal.prev_hash != prev_hash:
            return {"valid": False, "checked": checked, "problem": "chain_broken", "seq": seal.seq}
        content = compute_content_hash(seal.event)
        if content != seal.event.content_hash:
            return {
                "valid": False,
                "checked": checked,
                "problem": "event_modified",
                "seq": seal.seq,
                "event_id": str(seal.event_id),
            }
        expected = hashlib.sha256(f"{prev_hash}{content}".encode()).hexdigest()
        if expected != seal.chain_hash:
            return {"valid": False, "checked": checked, "problem": "seal_modified", "seq": seal.seq}
        prev_hash, checked, expected_seq = seal.chain_hash, checked + 1, expected_seq + 1
    unsealed = AuditEvent.objects.filter(seal__isnull=True).count()
    return {"valid": True, "checked": checked, "head": prev_hash, "unsealed": unsealed}
