from django.db import migrations

SQL = """
CREATE OR REPLACE FUNCTION erp_document_version_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record: document versions are append-only; upload a new version'
    USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER document_versions_append_only BEFORE UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION erp_document_version_guard();
"""
REVERSE = """
DROP TRIGGER IF EXISTS document_versions_append_only ON document_versions;
DROP FUNCTION IF EXISTS erp_document_version_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("documents", "0001_initial")]
    operations = [migrations.RunSQL(SQL, REVERSE)]
