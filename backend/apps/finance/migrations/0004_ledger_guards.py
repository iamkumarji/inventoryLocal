from django.db import migrations

from apps.core.db import posted_immutable_trigger_sql

ENTRY_FWD, ENTRY_REV = posted_immutable_trigger_sql(
    "journal_entries", "status", ["posted"], ["reversed_by_id", "updated_at", "updated_by_id"])

LINES_SQL = """
CREATE OR REPLACE FUNCTION erp_journal_line_guard() RETURNS trigger AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM journal_entries
   WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.entry_id ELSE OLD.entry_id END;
  IF parent_status = 'posted' THEN
    RAISE EXCEPTION 'immutable_record: lines of a posted journal cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION erp_journal_line_guard();

CREATE OR REPLACE FUNCTION erp_journal_balanced() RETURNS trigger AS $$
DECLARE dr numeric; cr numeric; n int;
BEGIN
  IF NEW.status <> 'posted' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*) INTO dr, cr, n
    FROM journal_lines WHERE entry_id = NEW.id;
  IF n < 2 OR dr <> cr OR dr = 0 THEN
    RAISE EXCEPTION 'unbalanced_journal: entry % debit % credit % lines %', NEW.id, dr, cr, n USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION erp_journal_balanced();
"""
LINES_REV = """
DROP TRIGGER IF EXISTS journal_entries_balanced ON journal_entries;
DROP TRIGGER IF EXISTS journal_lines_guard ON journal_lines;
DROP FUNCTION IF EXISTS erp_journal_balanced();
DROP FUNCTION IF EXISTS erp_journal_line_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("finance", "0003_initial"), ("core", "0003_db_guard_functions")]
    operations = [migrations.RunSQL(ENTRY_FWD, ENTRY_REV), migrations.RunSQL(LINES_SQL, LINES_REV)]
