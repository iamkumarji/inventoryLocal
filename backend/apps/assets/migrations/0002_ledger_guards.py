from django.db import migrations

from apps.core.db import append_only_trigger_sql, posted_immutable_trigger_sql

ENTRY_FWD, ENTRY_REV = append_only_trigger_sql("depreciation_entries")
SPARE_FWD, SPARE_REV = append_only_trigger_sql("maintenance_work_order_spares")
METER_FWD, METER_REV = append_only_trigger_sql("asset_meter_readings")
# A posted run is frozen except for the reversal bookkeeping.
RUN_FWD, RUN_REV = posted_immutable_trigger_sql(
    "depreciation_runs",
    "status",
    ["posted", "reversed"],
    ["status", "version", "updated_at", "updated_by_id", "reversal_journal_id", "reversed_by_id", "reversed_at",
     "reversal_reason"],
)


class Migration(migrations.Migration):
    dependencies = [("assets", "0001_initial"), ("core", "0003_db_guard_functions")]
    operations = [
        migrations.RunSQL(ENTRY_FWD, ENTRY_REV),
        migrations.RunSQL(SPARE_FWD, SPARE_REV),
        migrations.RunSQL(METER_FWD, METER_REV),
        migrations.RunSQL(RUN_FWD, RUN_REV),
    ]
