from django.db import migrations

SQL = """
CREATE OR REPLACE FUNCTION erp_bom_child_guard() RETURNS trigger AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM bom_versions
   WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'immutable_record: approved BOM versions cannot change; create a new version'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bom_components_guard BEFORE INSERT OR UPDATE OR DELETE ON bom_components
  FOR EACH ROW EXECUTE FUNCTION erp_bom_child_guard();
CREATE TRIGGER routing_operations_guard BEFORE INSERT OR UPDATE OR DELETE ON routing_operations
  FOR EACH ROW EXECUTE FUNCTION erp_bom_child_guard();
"""
REVERSE = """
DROP TRIGGER IF EXISTS bom_components_guard ON bom_components;
DROP TRIGGER IF EXISTS routing_operations_guard ON routing_operations;
DROP FUNCTION IF EXISTS erp_bom_child_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("manufacturing", "0001_initial")]
    operations = [migrations.RunSQL(SQL, REVERSE)]
