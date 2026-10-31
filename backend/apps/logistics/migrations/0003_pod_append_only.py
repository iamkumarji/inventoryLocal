from django.db import migrations

from apps.core.db import append_only_trigger_sql

FWD, REV = append_only_trigger_sql("proofs_of_delivery")


class Migration(migrations.Migration):
    dependencies = [("logistics", "0002_initial"), ("core", "0003_db_guard_functions")]
    operations = [migrations.RunSQL(FWD, REV)]
