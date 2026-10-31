"""Installation bootstrap: organization, first company, fiscal year, catalogue, templates, first admin.

Creates the first System Administrator by cloning the template role. The admin
must change the temporary password and enrol MFA at first login.
"""

from datetime import date

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.authorization import services as authz
from apps.authorization.models import Role
from apps.authorization.seeding import seed_templates, sync_permissions
from apps.core import flags
from apps.core.context import ActorContext
from apps.identity.models import User
from apps.organization import services as org_services
from apps.organization.models import Organization


class Command(BaseCommand):
    help = "Bootstrap a fresh installation (idempotent for the organization; fails if the admin exists)"

    def add_arguments(self, parser):
        parser.add_argument("--org-code", required=True)
        parser.add_argument("--org-name", required=True)
        parser.add_argument("--company-code", required=True)
        parser.add_argument("--company-name", required=True)
        parser.add_argument("--admin-email", required=True)
        parser.add_argument("--admin-name", default="System Administrator")
        parser.add_argument("--admin-password", required=True, help="Temporary; must be changed at first login")
        parser.add_argument("--fiscal-start-year", type=int, default=None)

    @transaction.atomic
    def handle(self, *args, **opts):
        ctx = ActorContext.system("bootstrap_erp")
        if User.objects.filter(email__iexact=opts["admin_email"]).exists():
            raise CommandError("Admin user already exists")
        org = Organization.objects.filter(code=opts["org_code"]).first() or org_services.create_organization(
            ctx, code=opts["org_code"], name=opts["org_name"]
        )
        company = org.companies.filter(code=opts["company_code"]).first() or org_services.create_company(
            ctx, organization=org, code=opts["company_code"], legal_name=opts["company_name"]
        )
        today = date.today()
        start_year = opts["fiscal_start_year"] or (
            today.year if today.month >= company.fiscal_year_start_month else today.year - 1
        )
        if not company.fiscal_years.exists():
            org_services.create_fiscal_year(ctx, company=company, start_year=start_year)

        sync_permissions()
        seed_templates(org)
        flags.register_module_flags()  # all business modules start disabled
        from apps.finance.services import install_chart

        install_chart(ctx, company)  # TEMPLATE chart and posting rules; edit to suit

        template = Role.objects.get(organization=org, code="tpl_system_admin")
        role = Role.objects.filter(organization=org, code="system_admin").first() or authz.clone_role(
            ctx, template, code="system_admin", name="System Administrator"
        )
        admin = User.objects.create_user(
            opts["admin_email"],
            opts["admin_password"],
            full_name=opts["admin_name"],
            organization=org,
            default_company=company,
            mfa_enforced=True,
            must_change_password=True,
        )
        authz.assign_role(
            ctx, user=admin, role=role, scope_type="organization", scope_id=org.pk, reason="Installation bootstrap"
        )
        self.stdout.write(
            self.style.SUCCESS(
                f"Bootstrapped organization={org.code} company={company.code} admin={admin.email}. "
                "The admin must change the password and enrol MFA at first login."
            )
        )
