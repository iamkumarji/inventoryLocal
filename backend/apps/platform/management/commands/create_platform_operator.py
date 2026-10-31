"""Create a platform operator: runs the hosting platform (creates/suspends organizations) and belongs to
no organization. They must enrol MFA and change the temporary password at first sign-in."""

from django.core.management.base import BaseCommand, CommandError

from apps.audit import services as audit
from apps.core.context import ActorContext
from apps.identity.models import User


class Command(BaseCommand):
    help = "Create a platform operator account (no organization, MFA enforced)"

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True)
        parser.add_argument("--name", default="Platform Operator")
        parser.add_argument("--password", required=True, help="Temporary; must be changed at first sign-in")

    def handle(self, *args, **opts):
        email = opts["email"].strip().lower()
        if User.objects.filter(email__iexact=email).exists():
            raise CommandError("That email already has an account.")
        user = User.objects.create_user(
            email,
            opts["password"],
            full_name=opts["name"],
            is_platform_operator=True,
            mfa_enforced=True,
            must_change_password=True,
        )
        audit.record(
            "platform.operator.created",
            ctx=ActorContext.system("create_platform_operator"),
            resource_type="identity.user",
            resource_id=user.pk,
            summary=email,
        )
        self.stdout.write(
            self.style.SUCCESS(f"Platform operator {email} created; MFA and a new password are required.")
        )
