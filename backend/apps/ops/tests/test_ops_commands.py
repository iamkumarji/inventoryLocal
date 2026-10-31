from datetime import date
from decimal import Decimal

import pytest
from cryptography.fernet import Fernet
from django.core.management import CommandError, call_command
from django.db import connection

from apps.core import crypto
from apps.core.ids import uuid7
from apps.core.models import FeatureFlag
from apps.inventory.engine import Move, post_stock
from apps.partners.models import Partner, PartnerBankAccount

pytestmark = pytest.mark.django_db
D = Decimal


@pytest.fixture
def flags(db):
    FeatureFlag.objects.create(key="module.inventory", enabled_default=True)


@pytest.fixture
def stocked(books, plant, make_item, system_ctx, flags):
    from django.db import transaction

    item = make_item("BOLT")
    with transaction.atomic():
        post_stock(
            system_ctx,
            company_id=books.pk,
            posting_date=date.today(),
            source_type="t",
            source_id=uuid7(),
            moves=[
                Move(
                    item=item,
                    warehouse=plant["rm"],
                    quantity=D("10"),
                    movement_type="opening",
                    unit_cost=D("5"),
                    contra_key="inventory_adjustment",
                )
            ],
        )
    return item


def test_verify_integrity_passes_on_consistent_books(stocked, capsys):
    call_command("verify_integrity")
    out = capsys.readouterr().out
    assert out.count("OK") == 5 and "FAIL" not in out


def test_verify_integrity_detects_stock_drift(stocked, plant):
    with connection.cursor() as cur:  # simulate a corrupted restore: valuation no longer matches the ledger
        cur.execute("UPDATE item_valuations SET value = value + 1 WHERE item_id = %s", [stocked.pk])
    with pytest.raises(CommandError, match="stock_matches_ledger"):
        call_command("verify_integrity")


def test_key_rotation_re_encrypts_and_old_key_can_be_retired(org, settings, capsys):
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    settings.FIELD_ENCRYPTION_KEYS = [old]
    crypto.reset_keys()
    partner = Partner.objects.create(
        organization=org, code="S1", name="S", is_supplier=True, gstin="27AAPFU0939F1ZV", state_code="27"
    )
    account = PartnerBankAccount.objects.create(
        organization=org,
        partner=partner,
        bank_name="SBI",
        ifsc="SBIN0001234",
        account_holder="S",
        account_number_encrypted=crypto.encrypt_str("123456789012"),
        account_last4="9012",
    )
    settings.FIELD_ENCRYPTION_KEYS = [new, old]  # rollover: new key first, old still readable
    call_command("rotate_field_keys")
    assert "rotated       1  partners.PartnerBankAccount.account_number_encrypted" in capsys.readouterr().out
    settings.FIELD_ENCRYPTION_KEYS = [new]  # old key retired
    crypto.reset_keys()
    account.refresh_from_db()
    assert crypto.decrypt_str(account.account_number_encrypted) == "123456789012"
    call_command("verify_integrity")  # encrypted values readable with the new key alone


def test_missing_key_is_reported(org, settings):
    settings.FIELD_ENCRYPTION_KEYS = [Fernet.generate_key().decode()]
    crypto.reset_keys()
    partner = Partner.objects.create(
        organization=org, code="S2", name="S", is_supplier=True, gstin="27AAPFU0939F1ZV", state_code="27"
    )
    PartnerBankAccount.objects.create(
        organization=org,
        partner=partner,
        bank_name="SBI",
        ifsc="SBIN0001234",
        account_holder="S",
        account_number_encrypted=crypto.encrypt_str("1"),
        account_last4="0001",
    )
    settings.FIELD_ENCRYPTION_KEYS = [Fernet.generate_key().decode()]  # the key was lost
    with pytest.raises(CommandError, match="encrypted_values_readable"):
        call_command("verify_integrity")
    crypto.reset_keys()
