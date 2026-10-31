"""The reference guard must place every model in its organization through required fields."""

import pytest
from django.apps import apps

from apps.authorization.tenancy import organization_path, restrict
from apps.finance.models import JournalLine

pytestmark = pytest.mark.req("ADM-010")


def test_optional_fields_are_not_used_when_a_required_parent_exists():
    # JournalLine has an optional warehouse; its organization comes from the required entry.
    assert organization_path(JournalLine) == "entry__company__organization_id"


def test_every_tenant_model_has_a_path_through_required_fields():
    platform_level = {
        "audit.auditevent",
        "audit.auditchainseal",
        "authorization.permission",
        "core.featureflag",
        "core.inboxreceipt",
        "core.outboxevent",
    }
    missing = []
    for model in apps.get_models():
        if not model.__module__.startswith("apps.") or model._meta.label_lower in platform_level:
            continue
        if organization_path(model) is None:
            missing.append(model._meta.label)
    assert missing == []


@pytest.mark.django_db
def test_lines_without_the_optional_field_are_still_referenceable(books, system_ctx):
    from datetime import date
    from decimal import Decimal

    from apps.finance.models import Account
    from apps.finance.posting import Line, post_journal

    cash = Account.objects.get(company=books, code="1100")
    bank = Account.objects.get(company=books, code="1110")
    from django.db import transaction

    with transaction.atomic():
        entry = post_journal(
            system_ctx,
            company_id=books.pk,
            entry_date=date.today(),
            narration="t",
            source_module="test",
            lines=[Line(amount=Decimal("5"), account=cash), Line(amount=Decimal("-5"), account=bank)],
        )
    lines = restrict(JournalLine.objects.filter(entry=entry), books.organization_id)
    assert lines.count() == 2  # no warehouse on these lines, still found
