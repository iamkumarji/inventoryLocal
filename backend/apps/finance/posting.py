"""General-ledger posting engine (DATABASE_DESIGN §6).

Every module posts through `post_journal` inside its own business transaction, so a
document and its accounting entry commit or roll back together. Posted entries are
immutable (DB triggers) and balanced (deferred constraint trigger at commit).
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

from django.db import connection, transaction
from django.utils import timezone

from apps.audit import services as audit
from apps.core.context import ActorContext
from apps.core.exceptions import BusinessRuleViolation, InvalidStateTransition
from apps.organization.services import allocate_number, ensure_period_open

from .models import Account, AccountDetermination, JournalEntry, JournalLine

CENT = Decimal("0.0001")


@dataclass
class Line:
    """amount > 0 debits, amount < 0 credits. Give `account` or a determination `key`."""

    amount: Decimal
    account: Account | None = None
    key: str | None = None
    posting_group: str = ""
    warehouse_type: str = ""
    cost_center_id: UUID | None = None
    partner_id: UUID | None = None
    item_id: UUID | None = None
    warehouse_id: UUID | None = None
    description: str = ""


def resolve_account(company_id, key: str, posting_group: str = "", warehouse_type: str = "") -> Account:
    rows = list(
        AccountDetermination.objects.select_related("account").filter(company_id=company_id, key=key, is_active=True)
    )

    def score(row):
        if row.posting_group and row.posting_group != posting_group:
            return -1
        if row.warehouse_type and row.warehouse_type != warehouse_type:
            return -1
        # Where stock sits (WIP, transit) outranks what it is: RM in a WIP store is WIP.
        return (2 if row.warehouse_type else 0) + (1 if row.posting_group else 0)

    best = max(rows, key=score, default=None)
    if best is None or score(best) < 0:
        raise BusinessRuleViolation(
            f"No account is configured for '{key}'"
            + (f" (group {posting_group})" if posting_group else "")
            + (f" (warehouse type {warehouse_type})" if warehouse_type else "")
            + ". Set it under Finance → Posting rules.",
            code="account_determination_missing",
            meta={"key": key, "posting_group": posting_group, "warehouse_type": warehouse_type},
        )
    return best.account


def _validate_account(account: Account, company_id, line: Line) -> None:
    if account.company_id != company_id:
        raise BusinessRuleViolation(f"Account {account.code} belongs to another company.", code="account_company")
    if account.is_group or not account.is_active:
        raise BusinessRuleViolation(f"Account {account.code} can't receive postings.", code="account_not_postable")
    if account.is_control and line.partner_id is None:
        raise BusinessRuleViolation(
            f"Postings to {account.code} must name a customer or supplier.", code="control_account_needs_partner"
        )


def _net_lines(company_id, lines: list[Line]) -> list[tuple[Account, Line, Decimal]]:
    merged: OrderedDict[tuple, tuple[Account, Line, Decimal]] = OrderedDict()
    for line in lines:
        amount = Decimal(line.amount).quantize(CENT, rounding=ROUND_HALF_UP)
        if amount == 0:
            continue
        account = line.account or resolve_account(company_id, line.key, line.posting_group, line.warehouse_type)
        _validate_account(account, company_id, line)
        key = (account.pk, line.cost_center_id, line.partner_id, line.item_id, line.warehouse_id, line.description)
        if key in merged:
            acc, first, total = merged[key]
            merged[key] = (acc, first, total + amount)
        else:
            merged[key] = (account, line, amount)
    return [(a, line, amt) for a, line, amt in merged.values() if amt != 0]


def _insert(entry: JournalEntry, netted) -> Decimal:
    total = Decimal("0")
    JournalLine.objects.bulk_create(
        [
            JournalLine(
                entry=entry,
                line_no=i + 1,
                account=account,
                debit=amt if amt > 0 else 0,
                credit=-amt if amt < 0 else 0,
                cost_center_id=line.cost_center_id,
                partner_id=line.partner_id,
                item_id=line.item_id,
                warehouse_id=line.warehouse_id,
                description=line.description[:300],
            )
            for i, (account, line, amt) in enumerate(netted)
        ]
    )
    for _, _, amt in netted:
        if amt > 0:
            total += amt
    return total


def post_journal(
    ctx: ActorContext,
    *,
    company_id,
    entry_date: date,
    lines: list[Line],
    narration: str,
    source_module: str,
    source_type: str = "",
    source_id: UUID | None = None,
    reverses: JournalEntry | None = None,
) -> JournalEntry | None:
    """Post a balanced entry. Returns None when every line nets to zero (nothing to account for).

    Authorization is the caller's job: the business document's own permission covers its accounting.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("post_journal must run inside the business transaction")
    netted = _net_lines(company_id, lines)
    if not netted:
        return None
    imbalance = sum((amt for _, _, amt in netted), Decimal("0"))
    if imbalance != 0:
        raise BusinessRuleViolation(f"Journal doesn't balance (difference {imbalance}).", code="unbalanced_journal")
    period = ensure_period_open(company_id, entry_date, "gl")
    entry = JournalEntry.objects.create(
        company_id=company_id,
        entry_date=entry_date,
        fiscal_period=period,
        source_module=source_module,
        source_type=source_type,
        source_id=source_id,
        narration=narration[:500],
        created_by=ctx.user,
        updated_by=ctx.user,
        is_reversal=reverses is not None,
        reverses=reverses,
    )
    entry.total = _insert(entry, netted)
    entry.number = allocate_number(company_id, "JE", entry_date)
    entry.status = JournalEntry.Status.POSTED
    entry.posted_at, entry.posted_by = timezone.now(), ctx.user
    entry.save(update_fields=["total", "number", "status", "posted_at", "posted_by"])
    return entry


@transaction.atomic
def reverse_journal(ctx: ActorContext, entry: JournalEntry, *, reversal_date: date, reason: str) -> JournalEntry:
    entry = JournalEntry.objects.select_for_update().get(pk=entry.pk)
    if entry.status != JournalEntry.Status.POSTED:
        raise InvalidStateTransition("Only posted entries can be reversed.")
    if entry.reversed_by_id or entry.is_reversal:
        raise InvalidStateTransition("This entry is already reversed or is itself a reversal.")
    lines = [
        Line(
            amount=line.credit - line.debit,
            account=line.account,
            cost_center_id=line.cost_center_id,
            partner_id=line.partner_id,
            item_id=line.item_id,
            warehouse_id=line.warehouse_id,
            description=line.description,
        )
        for line in entry.lines.select_related("account")
    ]
    reversal = post_journal(
        ctx,
        company_id=entry.company_id,
        entry_date=reversal_date,
        lines=lines,
        narration=f"Reversal of {entry.number}: {reason}"[:500],
        source_module=entry.source_module,
        source_type=entry.source_type,
        source_id=entry.source_id,
        reverses=entry,
    )
    entry.reversed_by = reversal
    entry.save(update_fields=["reversed_by", "updated_at"])
    audit.record(
        "finance.journal_entry.reversed",
        ctx=ctx,
        resource_type="finance.journal_entry",
        resource_id=entry.pk,
        company_id=entry.company_id,
        summary=reason,
        changes={"reversal": str(reversal.pk), "number": reversal.number},
    )
    reversal.refresh_from_db()
    return reversal
