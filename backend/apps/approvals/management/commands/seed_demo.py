"""DEVELOPMENT-ONLY demo data. Every record is labelled DEMO.

Requires DEBUG and ERP_DEMO_DATA. Run after `bootstrap_erp`. All data goes through the
real services (authorization, approvals, audit, outbox), so it exercises the real rules.
"""

from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.approvals import demo
from apps.approvals import services as approvals
from apps.approvals.models import ApprovalLevel, ApprovalMatrix
from apps.authorization import services as authz
from apps.authorization.models import Permission
from apps.authorization.seeding import sync_permissions
from apps.core import flags
from apps.core.context import ActorContext
from apps.core.ids import uuid7
from apps.core.models import FeatureFlag
from apps.core.outbox import relay_batch
from apps.identity.models import User
from apps.organization import services as org
from apps.organization.models import Branch, Organization

DEMO_PASSWORD = "Demo-Passw0rd-2026!"  # development only; printed so testers can sign in


class Command(BaseCommand):
    help = "Seed clearly labelled DEMO data for local development (refuses to run unless DEBUG)"

    def add_arguments(self, parser):
        parser.add_argument("--organization", default="DEMO")

    @transaction.atomic
    def handle(self, *args, **opts):
        if not demo.enabled():
            raise CommandError("Demo data is development-only: requires DEBUG and ERP_DEMO_DATA.")
        organization = Organization.objects.filter(code=opts["organization"]).first()
        if organization is None:
            raise CommandError("Run bootstrap_erp first.")
        company = organization.companies.order_by("created_at").first()
        if Branch.objects.filter(company=company, code="PUN").exists():
            raise CommandError("Demo data already present.")
        ctx = ActorContext.system("seed_demo")
        sync_permissions()

        pune = org.create_branch(ctx, company=company, code="PUN", name="Pune works (DEMO)", state_code="27")
        chakan = org.create_branch(ctx, company=company, code="CHK", name="Chakan plant (DEMO)", state_code="27")
        plant = org.create_facility(
            ctx, branch=pune, code="PUN-P1", name="Machining shop (DEMO)", facility_type="plant"
        )
        org.create_facility(ctx, branch=chakan, code="CHK-P1", name="Assembly line (DEMO)", facility_type="plant")
        for code, name, kind, branch, facility in (
            ("PUN-RM", "Raw material store (DEMO)", "raw_material", pune, plant),
            ("PUN-WIP", "Shop-floor WIP (DEMO)", "wip", pune, plant),
            ("PUN-FG", "Finished goods (DEMO)", "finished_goods", pune, None),
            ("PUN-QC", "Quality hold (DEMO)", "quarantine", pune, None),
            ("CHK-RM", "Chakan stores (DEMO)", "raw_material", chakan, None),
        ):
            org.create_warehouse(ctx, branch=branch, facility=facility, code=code, name=name, warehouse_type=kind)
        for code, name in (("PROD", "Production"), ("STORES", "Stores"), ("PURCH", "Purchase"), ("FIN", "Finance")):
            org.create_department(ctx, company=company, code=code, name=f"{name} (DEMO)")

        FeatureFlag.objects.update_or_create(
            key="module.demo",
            defaults={"enabled_default": True, "description": "DEMO document types (development only)."},
        )
        flags.register_module_flags()

        perms = {p.code for p in Permission.objects.filter(code__startswith=f"{demo.DOCUMENT_TYPE}.")}
        requester_role = authz.create_role(
            ctx,
            organization=organization,
            code="demo_requester",
            name="Requester (DEMO)",
            permission_codes=sorted(p for p in perms if p.endswith((".create", ".read"))),
        )
        supervisor_role = authz.create_role(
            ctx,
            organization=organization,
            code="demo_stores_supervisor",
            name="Stores supervisor (DEMO)",
            permission_codes=sorted(p for p in perms if not p.endswith(".create")),
        )
        head_role = authz.create_role(
            ctx,
            organization=organization,
            code="demo_plant_head",
            name="Plant head (DEMO)",
            permission_codes=sorted(p for p in perms if not p.endswith(".create")),
        )
        authz.set_approval_limit(
            ctx,
            organization=organization,
            role=supervisor_role,
            document_type=demo.DOCUMENT_TYPE,
            currency="INR",
            max_amount=Decimal("100000"),
        )
        authz.set_approval_limit(
            ctx,
            organization=organization,
            role=head_role,
            document_type=demo.DOCUMENT_TYPE,
            currency="INR",
            max_amount=Decimal("1000000"),
        )

        people = {}
        for key, email, name in (
            ("requester", "priya.requester@demo.local", "Priya Kulkarni (DEMO)"),
            ("supervisor", "rahul.supervisor@demo.local", "Rahul Deshmukh (DEMO)"),
            ("head", "meera.planthead@demo.local", "Meera Iyer (DEMO)"),
        ):
            people[key] = User.objects.create_user(
                email, DEMO_PASSWORD, full_name=name, organization=organization, default_company=company
            )
        authz.assign_role(
            ctx,
            user=people["requester"],
            role=requester_role,
            scope_type="branch",
            scope_id=pune.pk,
            reason="DEMO data",
        )
        authz.assign_role(
            ctx,
            user=people["supervisor"],
            role=supervisor_role,
            scope_type="branch",
            scope_id=pune.pk,
            reason="DEMO data",
        )
        authz.assign_role(
            ctx, user=people["head"], role=head_role, scope_type="company", scope_id=company.pk, reason="DEMO data"
        )

        matrix = ApprovalMatrix.objects.create(
            organization=organization, document_type=demo.DOCUMENT_TYPE, name="DEMO purchase request route"
        )
        ApprovalLevel.objects.create(
            matrix=matrix,
            sequence=1,
            name="Stores supervisor",
            role=supervisor_role,
            escalation_hours=24,
            escalation_role=head_role,
        )
        ApprovalLevel.objects.create(
            matrix=matrix, sequence=2, name="Plant head", role=head_role, min_amount=Decimal("100000.01")
        )

        requester_ctx = ActorContext(user=people["requester"], company_id=company.pk, client_type="system")
        submitted = []
        for title, amount, summary in (
            ("Cutting inserts for CNC line 2", "45000", {"supplier": "DEMO Tooling Pvt Ltd", "items": "120 inserts"}),
            ("Hydraulic press seal kit", "240000", {"supplier": "DEMO Hydraulics", "items": "4 seal kits"}),
            ("Safety gloves, quarterly stock", "8500", {"supplier": "DEMO Safety Supplies", "items": "500 pairs"}),
        ):
            submitted.append(
                approvals.submit(
                    requester_ctx,
                    document_type=demo.DOCUMENT_TYPE,
                    document_id=uuid7(),
                    company_id=company.pk,
                    title=f"{title} (DEMO)",
                    amount=Decimal(amount),
                    currency="INR",
                    document_number=f"DEMO-PR-{len(submitted) + 1:04d}",
                    summary=summary,
                    scope={"branch_id": pune.pk},
                )
            )
        supervisor_ctx = ActorContext(user=people["supervisor"], company_id=company.pk, client_type="system")
        approvals.decide(supervisor_ctx, submitted[1], approve=True, comment="Seals are worn; agreed. (DEMO)")
        transaction.on_commit(lambda: [relay_batch() for _ in range(3)])

        self.stdout.write(self.style.WARNING("DEMO data created for development only."))
        for person in people.values():
            self.stdout.write(f"  {person.email} / {DEMO_PASSWORD}")
