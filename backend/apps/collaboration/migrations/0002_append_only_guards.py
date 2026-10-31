from django.db import migrations

SQL = """
CREATE OR REPLACE FUNCTION erp_collab_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record: % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION erp_collab_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record: % rows are append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER collab_comments_no_delete BEFORE DELETE ON collab_comments
  FOR EACH ROW EXECUTE FUNCTION erp_collab_no_delete();
CREATE TRIGGER collab_comment_revisions_append_only BEFORE UPDATE OR DELETE ON collab_comment_revisions
  FOR EACH ROW EXECUTE FUNCTION erp_collab_append_only();
"""
REVERSE = """
DROP TRIGGER IF EXISTS collab_comments_no_delete ON collab_comments;
DROP TRIGGER IF EXISTS collab_comment_revisions_append_only ON collab_comment_revisions;
DROP FUNCTION IF EXISTS erp_collab_no_delete();
DROP FUNCTION IF EXISTS erp_collab_append_only();
"""


class Migration(migrations.Migration):
    dependencies = [("collaboration", "0001_initial")]
    operations = [migrations.RunSQL(SQL, REVERSE)]
