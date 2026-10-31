"""Database-level guards for append-only and posted records (DATABASE_DESIGN §6)."""

FORBID_MUTATION_FUNCTION = """
CREATE OR REPLACE FUNCTION erp_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END
$$ LANGUAGE plpgsql;
"""

# Blocks UPDATE/DELETE once the row's status is in the given list, except for
# updates that touch only whitelisted columns (e.g. reversed_by_id).
FORBID_POSTED_MUTATION_FUNCTION = """
CREATE OR REPLACE FUNCTION erp_forbid_posted_mutation() RETURNS trigger AS $$
DECLARE
  status_col text := TG_ARGV[0];
  frozen_statuses text[] := string_to_array(TG_ARGV[1], ',');
  allowed_cols text[] := string_to_array(COALESCE(TG_ARGV[2], ''), ',');
  old_status text;
  old_j jsonb;
  new_j jsonb;
  k text;
BEGIN
  old_j := to_jsonb(OLD);
  old_status := old_j ->> status_col;
  IF old_status IS NULL OR NOT (old_status = ANY(frozen_statuses)) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable_record: DELETE on posted % is not allowed', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  new_j := to_jsonb(NEW);
  FOR k IN SELECT jsonb_object_keys(old_j) LOOP
    IF (old_j -> k) IS DISTINCT FROM (new_j -> k) AND NOT (k = ANY(allowed_cols)) THEN
      RAISE EXCEPTION 'immutable_record: column % of posted % cannot change', k, TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
"""

DROP_FUNCTIONS = """
DROP FUNCTION IF EXISTS erp_forbid_posted_mutation();
DROP FUNCTION IF EXISTS erp_forbid_mutation();
"""


def append_only_trigger_sql(table: str) -> tuple[str, str]:
    """(forward, reverse) SQL making `table` append-only."""
    name = f"{table}_append_only"
    forward = (
        f"CREATE TRIGGER {name} BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION erp_forbid_mutation();"
    )
    return forward, f"DROP TRIGGER IF EXISTS {name} ON {table};"


def posted_immutable_trigger_sql(
    table: str, status_column: str, frozen_statuses: list[str], allowed_columns: list[str] | None = None
) -> tuple[str, str]:
    name = f"{table}_posted_immutable"
    args = ", ".join(
        f"'{value}'" for value in (status_column, ",".join(frozen_statuses), ",".join(allowed_columns or []))
    )
    forward = (
        f"CREATE TRIGGER {name} BEFORE UPDATE OR DELETE ON {table} "
        f"FOR EACH ROW EXECUTE FUNCTION erp_forbid_posted_mutation({args});"
    )
    return forward, f"DROP TRIGGER IF EXISTS {name} ON {table};"
