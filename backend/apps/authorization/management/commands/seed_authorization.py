from django.core.management.base import BaseCommand, CommandError

from apps.authorization.seeding import seed_templates, sync_permissions
from apps.organization.models import Organization


class Command(BaseCommand):
    help = "Sync permissions and (re)seed TEMPLATE roles, ABAC policy templates and SoD rules"

    def add_arguments(self, parser):
        parser.add_argument("--organization", required=True, help="Organization code")

    def handle(self, *args, **options):
        org = Organization.objects.filter(code=options["organization"]).first()
        if org is None:
            raise CommandError("Organization not found")
        self.stdout.write(f"Permissions: {sync_permissions()}")
        self.stdout.write(self.style.SUCCESS(f"Templates: {seed_templates(org)}"))
