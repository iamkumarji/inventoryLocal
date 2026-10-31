from django.db import migrations

from apps.core.db import append_only_trigger_sql

LEDGER_FWD, LEDGER_REV = append_only_trigger_sql("stock_ledger_entries")
SERIAL_FWD, SERIAL_REV = append_only_trigger_sql("stock_ledger_serials")

TXN_SQL = """
CREATE OR REPLACE FUNCTION erp_stock_txn_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable_record: stock transactions cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  -- The only permitted change: attaching the journal entry once, in the posting transaction.
  IF OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL
     AND (to_jsonb(NEW) - 'journal_entry_id') = (to_jsonb(OLD) - 'journal_entry_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'immutable_record: stock transactions cannot change' USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_transactions_guard BEFORE UPDATE OR DELETE ON stock_transactions
  FOR EACH ROW EXECUTE FUNCTION erp_stock_txn_guard();
"""
TXN_REV = "DROP TRIGGER IF EXISTS stock_transactions_guard ON stock_transactions; DROP FUNCTION IF EXISTS erp_stock_txn_guard();"


class Migration(migrations.Migration):
    dependencies = [("inventory", "0002_initial"), ("core", "0003_db_guard_functions")]
    operations = [
        migrations.RunSQL(LEDGER_FWD, LEDGER_REV),
        migrations.RunSQL(SERIAL_FWD, SERIAL_REV),
        migrations.RunSQL(TXN_SQL, TXN_REV),
    ]
