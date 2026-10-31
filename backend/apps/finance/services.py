from datetime import date

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied, InvalidStateTransition
from apps.organization.services import allocate_number, ensure_period_open

from . import chart_template
from .models import Account, AccountDetermination, JournalEntry, JournalLine
from .posting import Line, _insert, _net_lines


@transaction.atomic
def install_chart(ctx: ActorContext, company) -> int:
    """Install the template chart and posting rules once (idempotent)."""
    pdp.require(ctx, "finance.account.create", pdp.Resource.ref("finance.account", company_id=company.pk))
    if Account.objects.filter(company=company).exists():
        return 0
    by_code = {}
    for code, name, kind, sub, parent, group, control in chart_template.ACCOUNTS:
        by_code[code] = Account.objects.create(
            company=company,
            code=code,
            name=name,
            account_type=kind,
            sub_type=sub,
            parent=by_code.get(parent),
            is_group=group,
            is_control=control,
            created_by=ctx.user,
            updated_by=ctx.user,
        )
    for key, group, wh_type, code in chart_template.DETERMINATIONS:
        AccountDetermination.objects.create(
            company=company,
            key=key,
            posting_group=group,
            warehouse_type=wh_type,
            account=by_code[code],
            created_by=ctx.user,
            updated_by=ctx.user,
        )
    audit.record(
        "finance.chart.installed",
        ctx=ctx,
        resource_type="organization.company",
        resource_id=company.pk,
        company_id=company.pk,
        summary=f"{len(by_code)} accounts from template",
    )
    return len(by_code)


@transaction.atomic
def create_manual_journal(
    ctx: ActorContext, *, company, entry_date: date, narration: str, lines: list[dict]
) -> JournalEntry:
    pdp.require(ctx, "finance.journal_entry.create", pdp.Resource.ref("finance.journal_entry", company_id=company.pk))
    netted = _net_lines(company.pk, [Line(**line) for line in lines])
    if len(netted) < 2:
        raise ValidationError({"lines": ["A journal needs at least one debit and one credit."]})
    if sum(amt for _, _, amt in netted) != 0:
        raise ValidationError({"lines": ["Debits and credits must be equal."]})
    entry = JournalEntry.objects.create(
        company=company,
        entry_date=entry_date,
        narration=narration,
        source_module="finance",
        source_type="manual",
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    entry.total = _insert(entry, netted)
    entry.save(update_fields=["total"])
    audit.record(
        "finance.journal_entry.drafted",
        ctx=ctx,
        resource_type="finance.journal_entry",
        resource_id=entry.pk,
        company_id=company.pk,
        summary=narration,
    )
    return entry


@transaction.atomic
def post_manual_journal(ctx: ActorContext, entry: JournalEntry, expected_version: int | None = None) -> JournalEntry:
    entry = JournalEntry.objects.select_for_update().get(pk=entry.pk)
    if entry.status != JournalEntry.Status.DRAFT:
        raise InvalidStateTransition("Only draft journals can be posted.")
    if expected_version is not None and entry.version != expected_version:
        from apps.core.exceptions import VersionConflict

        raise VersionConflict()
    resource = pdp.Resource.of(entry)
    pdp.require(ctx, "finance.journal_entry.post", resource)
    if entry.created_by_id == ctx.user_id and not pdp.can(ctx, "finance.journal_entry.self_approve", resource):
        raise AuthorizationDenied(reason="maker_checker")
    period = ensure_period_open(entry.company_id, entry.entry_date, "gl")
    entry.fiscal_period = period
    entry.number = allocate_number(entry.company_id, "JE", entry.entry_date)
    entry.status, entry.posted_at, entry.posted_by = JournalEntry.Status.POSTED, timezone.now(), ctx.user
    entry.version += 1
    entry.save()
    audit.record(
        "finance.journal_entry.posted",
        ctx=ctx,
        resource_type="finance.journal_entry",
        resource_id=entry.pk,
        company_id=entry.company_id,
        summary=entry.number,
    )
    return entry


def lines_of(entry: JournalEntry):
    return JournalLine.objects.filter(entry=entry).select_related("account", "partner", "cost_center")
