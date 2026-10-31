"""Post-restore and periodic integrity checks. Exits non-zero when anything is wrong.

Checks: audit hash chain; every posted journal balanced; sub-ledgers (stock, AR, AP) equal their GL
control accounts per company; stock valuation and balances equal the stock ledger; every encrypted
value decrypts with the configured keys.
"""

import json
from decimal import Decimal

from cryptography.fernet import InvalidToken
from django.apps import apps
from django.core.management.base import BaseCommand, CommandError
from django.db.models import F, Q, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.audit.services import verify_chain
from apps.core import crypto

ZERO = Decimal("0")


def _journals() -> dict:
    from apps.finance.models import JournalLine

    unbalanced = list(
        JournalLine.objects.filter(entry__status="posted")
        .values("entry_id", "entry__number")
        .annotate(diff=Sum(F("debit") - F("credit")))
        .exclude(diff=0)[:20]
    )
    return {
        "ok": not unbalanced,
        "unbalanced": [{"entry": r["entry__number"], "difference": str(r["diff"])} for r in unbalanced],
    }


def _subledgers(as_of) -> dict:
    from apps.finance.subledger import subledger_reconciliation
    from apps.organization.models import Company

    problems = []
    for company in Company.objects.all():
        for check in subledger_reconciliation(company.pk, as_of):
            if not check["ok"]:
                problems.append(
                    {"company": company.code, "check": check["check"], "difference": str(check["difference"])}
                )
    return {"ok": not problems, "problems": problems}


def _stock() -> dict:
    from apps.inventory.models import ItemValuation, StockBalance, StockLedgerEntry

    ledger = {
        (r["item_id"], r["warehouse_id"]): (r["q"], r["v"])
        for r in StockLedgerEntry.objects.values("item_id", "warehouse_id").annotate(
            q=Coalesce(Sum("quantity"), ZERO), v=Coalesce(Sum("value"), ZERO)
        )
    }
    balances = {
        (r["item_id"], r["warehouse_id"]): r["q"]
        for r in StockBalance.objects.values("item_id", "warehouse_id").annotate(q=Coalesce(Sum("quantity"), ZERO))
    }
    problems = []
    for val in ItemValuation.objects.all().iterator():
        key = (val.item_id, val.warehouse_id)
        q, v = ledger.pop(key, (ZERO, ZERO))
        if val.quantity != q or val.value != v or balances.get(key, ZERO) != q:
            problems.append(
                {
                    "item": str(val.item_id),
                    "warehouse": str(val.warehouse_id),
                    "valuation": [str(val.quantity), str(val.value)],
                    "ledger": [str(q), str(v)],
                    "balances": str(balances.get(key, ZERO)),
                }
            )
    for (item, warehouse), (q, v) in ledger.items():
        if q or v:
            problems.append(
                {"item": str(item), "warehouse": str(warehouse), "valuation": None, "ledger": [str(q), str(v)]}
            )
    return {"ok": not problems, "problems": problems[:50]}


def _encryption() -> dict:
    crypto.reset_keys()
    unreadable = {}
    for label, field in crypto.ENCRYPTED_COLUMNS:
        model = apps.get_model(label)
        bad = 0
        for token in (
            model.objects.exclude(Q(**{field: ""}) | Q(**{f"{field}__isnull": True}))
            .values_list(field, flat=True)
            .iterator()
        ):
            try:
                crypto.decrypt_str(token)
            except InvalidToken:  # missing or wrong key
                bad += 1
        if bad:
            unreadable[f"{label}.{field}"] = bad
    return {"ok": not unreadable, "unreadable": unreadable}


class Command(BaseCommand):
    help = "Verify ledgers, audit chain and encrypted data (run after every restore and nightly)"

    def add_arguments(self, parser):
        parser.add_argument("--json", action="store_true", help="Print the full report as JSON")

    def handle(self, *args, **opts):
        chain = verify_chain()
        report = {
            "audit_chain": {"ok": chain["valid"], **{k: v for k, v in chain.items() if k != "valid"}},
            "journals_balanced": _journals(),
            "subledgers_match_gl": _subledgers(timezone.localdate()),
            "stock_matches_ledger": _stock(),
            "encrypted_values_readable": _encryption(),
        }
        if opts["json"]:
            self.stdout.write(json.dumps(report, indent=2, default=str))
        else:
            for name, result in report.items():
                self.stdout.write(f"{'OK  ' if result['ok'] else 'FAIL'}  {name}")
        failed = [name for name, result in report.items() if not result["ok"]]
        if failed:
            raise CommandError(f"Integrity checks failed: {', '.join(failed)}")
