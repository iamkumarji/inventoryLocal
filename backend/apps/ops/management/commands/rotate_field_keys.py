"""Re-encrypt every encrypted column under the current key (the first of FIELD_ENCRYPTION_KEYS).

Rollover: put the new key first and keep the old key after it, deploy, run this command, confirm
`verify_integrity` passes with only the new key configured in a staging copy, then drop the old key.
"""

from django.apps import apps
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q

from apps.audit import services as audit
from apps.core import crypto
from apps.core.context import ActorContext

BATCH = 500


class Command(BaseCommand):
    help = "Re-encrypt field-level secrets with the current FIELD_ENCRYPTION_KEYS key"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Count rows without writing")

    def handle(self, *args, dry_run=False, **opts):
        crypto.reset_keys()
        totals = {}
        for label, field in crypto.ENCRYPTED_COLUMNS:
            model = apps.get_model(label)
            rows = model.objects.exclude(Q(**{field: ""}) | Q(**{f"{field}__isnull": True})).order_by("pk")
            done, last = 0, None
            while True:
                batch = rows.filter(pk__gt=last) if last is not None else rows
                chunk = list(batch.values_list("pk", field)[:BATCH])
                if not chunk:
                    break
                if not dry_run:
                    with transaction.atomic():
                        for pk, token in chunk:
                            # update() writes only this column and skips model save hooks and version bumps.
                            model.objects.filter(pk=pk).update(**{field: crypto.rotate_token(token)})
                done += len(chunk)
                last = chunk[-1][0]
            totals[f"{label}.{field}"] = done
        if not dry_run:
            audit.record(
                "core.encryption_keys.rotated",
                ctx=ActorContext.system("rotate_field_keys"),
                resource_type="core.encryption_key",
                summary=f"{sum(totals.values())} values re-encrypted",
                changes=totals,
            )
        for column, count in totals.items():
            self.stdout.write(f"{'would rotate' if dry_run else 'rotated'} {count:>7}  {column}")
