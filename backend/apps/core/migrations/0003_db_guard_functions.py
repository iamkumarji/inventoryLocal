from django.db import migrations

from apps.core.db import DROP_FUNCTIONS, FORBID_MUTATION_FUNCTION, FORBID_POSTED_MUTATION_FUNCTION


class Migration(migrations.Migration):
    dependencies = [("core", "0002_initial")]

    operations = [
        migrations.RunSQL(FORBID_MUTATION_FUNCTION + FORBID_POSTED_MUTATION_FUNCTION, reverse_sql=DROP_FUNCTIONS),
    ]
