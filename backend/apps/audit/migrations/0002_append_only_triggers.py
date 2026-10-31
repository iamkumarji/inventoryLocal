from django.db import migrations

from apps.core.db import append_only_trigger_sql

EVENTS_FWD, EVENTS_REV = append_only_trigger_sql("audit_events")
SEALS_FWD, SEALS_REV = append_only_trigger_sql("audit_chain_seals")


class Migration(migrations.Migration):
    dependencies = [("audit", "0001_initial"), ("core", "0003_db_guard_functions")]

    operations = [
        migrations.RunSQL(EVENTS_FWD, reverse_sql=EVENTS_REV),
        migrations.RunSQL(SEALS_FWD, reverse_sql=SEALS_REV),
    ]
