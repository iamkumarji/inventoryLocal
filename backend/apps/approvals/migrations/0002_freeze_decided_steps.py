from django.db import migrations

from apps.core.db import posted_immutable_trigger_sql

FWD, REV = posted_immutable_trigger_sql("approval_steps", "status", ["approved", "rejected", "skipped"])


class Migration(migrations.Migration):
    dependencies = [("approvals", "0001_initial"), ("core", "0003_db_guard_functions")]

    operations = [migrations.RunSQL(FWD, reverse_sql=REV)]
