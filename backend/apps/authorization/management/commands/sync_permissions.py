from django.core.management.base import BaseCommand

from apps.authorization.seeding import sync_permissions


class Command(BaseCommand):
    help = "Synchronise the permission catalogue from apps/*/permissions.py"

    def handle(self, *args, **options):
        result = sync_permissions()
        self.stdout.write(self.style.SUCCESS(f"Permissions synced: {result}"))
