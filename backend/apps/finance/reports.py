"""Financial statements computed from posted journal lines (the ledger is the source of truth)."""

from datetime import date
from decimal import Decimal

from django.db.models import Q, Sum
from django.db.models.functions import Coalesce

from .models import Account, JournalLine

ZERO = Decimal("0")


def _sums(company_id, q: Q) -> dict:
    rows = (
        JournalLine.objects.filter(entry__company_id=company_id, entry__status="posted")
        .filter(q)
        .values("account_id")
        .annotate(dr=Coalesce(Sum("debit"), ZERO), cr=Coalesce(Sum("credit"), ZERO))
    )
    return {r["account_id"]: (r["dr"], r["cr"]) for r in rows}


def trial_balance(company_id, date_from: date, date_to: date) -> dict:
    opening = _sums(company_id, Q(entry__entry_date__lt=date_from))
    period = _sums(company_id, Q(entry__entry_date__gte=date_from, entry__entry_date__lte=date_to))
    rows, totals = [], {"opening": ZERO, "debit": ZERO, "credit": ZERO, "closing": ZERO}
    for account in Account.objects.filter(company_id=company_id, is_group=False).order_by("code"):
        o_dr, o_cr = opening.get(account.pk, (ZERO, ZERO))
        p_dr, p_cr = period.get(account.pk, (ZERO, ZERO))
        if not any((o_dr, o_cr, p_dr, p_cr)):
            continue
        opening_bal, closing = o_dr - o_cr, o_dr - o_cr + p_dr - p_cr  # debit-positive
        rows.append(
            {
                "account_id": str(account.pk),
                "code": account.code,
                "name": account.name,
                "account_type": account.account_type,
                "opening": opening_bal,
                "debit": p_dr,
                "credit": p_cr,
                "closing": closing,
            }
        )
        totals["opening"] += opening_bal
        totals["debit"] += p_dr
        totals["credit"] += p_cr
        totals["closing"] += closing
    return {
        "date_from": date_from,
        "date_to": date_to,
        "rows": rows,
        "totals": totals,
        "balanced": totals["debit"] == totals["credit"] and totals["closing"] == 0,
    }


def profit_and_loss(company_id, date_from: date, date_to: date) -> dict:
    sums = _sums(
        company_id,
        Q(
            entry__entry_date__gte=date_from,
            entry__entry_date__lte=date_to,
            account__account_type__in=["income", "expense"],
        ),
    )
    income, expenses = [], []
    total_income = total_expense = ZERO
    for account in Account.objects.filter(pk__in=sums.keys()).order_by("code"):
        dr, cr = sums[account.pk]
        if account.account_type == "income":
            amount = cr - dr
            total_income += amount
            income.append({"code": account.code, "name": account.name, "amount": amount})
        else:
            amount = dr - cr
            total_expense += amount
            expenses.append({"code": account.code, "name": account.name, "amount": amount})
    return {
        "date_from": date_from,
        "date_to": date_to,
        "income": income,
        "expenses": expenses,
        "total_income": total_income,
        "total_expense": total_expense,
        "net_profit": total_income - total_expense,
    }


def balance_sheet(company_id, as_of: date) -> dict:
    sums = _sums(company_id, Q(entry__entry_date__lte=as_of))
    sections = {"asset": [], "liability": [], "equity": []}
    totals = {"asset": ZERO, "liability": ZERO, "equity": ZERO}
    earnings = ZERO
    for account in Account.objects.filter(pk__in=sums.keys()).order_by("code"):
        dr, cr = sums[account.pk]
        if account.account_type in ("income", "expense"):
            earnings += cr - dr  # not yet closed to retained earnings
            continue
        amount = dr - cr if account.account_type == "asset" else cr - dr
        sections[account.account_type].append({"code": account.code, "name": account.name, "amount": amount})
        totals[account.account_type] += amount
    sections["equity"].append({"code": "", "name": "Current period earnings (unclosed)", "amount": earnings})
    totals["equity"] += earnings
    return {
        "as_of": as_of,
        "sections": sections,
        "totals": totals,
        "balanced": totals["asset"] == totals["liability"] + totals["equity"],
    }


def account_ledger(account: Account, date_from: date, date_to: date) -> dict:
    opening = JournalLine.objects.filter(account=account, entry__status="posted", entry__entry_date__lt=date_from)
    o = opening.aggregate(dr=Coalesce(Sum("debit"), ZERO), cr=Coalesce(Sum("credit"), ZERO))
    running = o["dr"] - o["cr"]
    lines = []
    for line in (
        JournalLine.objects.select_related("entry", "partner")
        .filter(
            account=account, entry__status="posted", entry__entry_date__gte=date_from, entry__entry_date__lte=date_to
        )
        .order_by("entry__entry_date", "entry__number", "line_no")
    ):
        running += line.debit - line.credit
        lines.append(
            {
                "date": line.entry.entry_date,
                "number": line.entry.number,
                "entry_id": str(line.entry_id),
                "narration": line.entry.narration,
                "partner": line.partner.name if line.partner else None,
                "debit": line.debit,
                "credit": line.credit,
                "balance": running,
                "source_type": line.entry.source_type,
                "source_id": line.entry.source_id,
            }
        )
    return {
        "account": {"id": str(account.pk), "code": account.code, "name": account.name},
        "opening": o["dr"] - o["cr"],
        "lines": lines,
        "closing": running,
    }


def partner_balance(company_id, partner_id, account_key_ids: list) -> Decimal:
    agg = JournalLine.objects.filter(
        entry__company_id=company_id, entry__status="posted", partner_id=partner_id, account_id__in=account_key_ids
    ).aggregate(dr=Coalesce(Sum("debit"), ZERO), cr=Coalesce(Sum("credit"), ZERO))
    return agg["dr"] - agg["cr"]
