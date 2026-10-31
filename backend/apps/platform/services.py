"""Tenant provisioning. Platform operators create organizations; everything inside one is then run by
that organization's own administrators. Operators never get grants inside a tenant."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date

from django.conf import settings
from django.db import transaction
from django.db.models import Count
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import services as authz
from apps.authorization.models import Role
from apps.authorization.seeding import seed_templates, sync_permissions
from apps.core.context import ActorContext
from apps.core.exceptions import AuthorizationDenied
from apps.identity.models import User
from apps.identity.services import revoke_session
from apps.organization import services as org_services
from apps.organization.models import Organization


def require_operator(ctx: ActorContext) -> None:
    """Platform actions need an operator who verified MFA recently (they reshape the whole platform)."""
    if ctx.is_system:
        return
    user = ctx.user
    if user is None or not getattr(user, "is_platform_operator", False) or user.organization_id is not None:
        raise AuthorizationDenied(reason="not_platform_operator")
    if not ctx.mfa_verified_within(settings.ERP["STEP_UP_MINUTES"]):
        from apps.core.exceptions import MFARequired

        raise MFARequired()


def _as_system(ctx: ActorContext, reason: str) -> ActorContext:
    """Installation-level authority for the provisioning steps, still attributed to the operator."""
    return replace(ctx, is_system=True, extra={**ctx.extra, "reason": reason})


@dataclass
class Provisioned:
    organization: Organization
    company: object
    admin: User


@transaction.atomic
def provision_organization(
    ctx: ActorContext,
    *,
    code: str,
    name: str,
    company_code: str,
    company_name: str,
    admin_email: str,
    admin_name: str,
    admin_password: str,
    fiscal_start_year: int | None = None,
    state_code: str = "",
    gstin: str = "",
) -> Provisioned:
    """A new tenant, ready to sign in to: organization, first company and fiscal year, role/policy
    templates, template chart of accounts, and a first administrator (MFA and password change forced)."""
    require_operator(ctx)
    operator, ctx = ctx, _as_system(ctx, "provision_organization")
    if Organization.objects.filter(code__iexact=code).exists():
        raise ValidationError({"code": ["An organization with this code already exists."]})
    if User.objects.filter(email__iexact=admin_email).exists():
        raise ValidationError({"admin_email": ["This email already has an account."]})
    organization = org_services.create_organization(ctx, code=code, name=name)
    company = org_services.create_company(
        ctx,
        organization=organization,
        code=company_code,
        legal_name=company_name,
        **({"state_code": state_code} if state_code else {}),
        **({"gstin": gstin} if gstin else {}),
    )
    today = date.today()
    start = fiscal_start_year or (today.year if today.month >= company.fiscal_year_start_month else today.year - 1)
    org_services.create_fiscal_year(ctx, company=company, start_year=start)
    sync_permissions()
    seed_templates(organization)
    from apps.finance.services import install_chart

    install_chart(ctx, company)
    template = Role.objects.get(organization=organization, code="tpl_system_admin")
    role = authz.clone_role(ctx, template, code="system_admin", name="System Administrator")
    admin = User.objects.create_user(
        admin_email.strip().lower(),
        admin_password,
        full_name=admin_name,
        organization=organization,
        default_company=company,
        mfa_enforced=True,
        must_change_password=True,
    )
    authz.assign_role(
        ctx,
        user=admin,
        role=role,
        scope_type="organization",
        scope_id=organization.pk,
        reason="Organization provisioned",
    )
    audit.record(
        "platform.organization.provisioned",
        ctx=operator,
        resource_type="organization.organization",
        resource_id=organization.pk,
        organization_id=organization.pk,
        summary=f"{organization.code} with company {company.code}, admin {admin.email}",
    )
    return Provisioned(organization, company, admin)


@transaction.atomic
def set_active(ctx: ActorContext, organization: Organization, *, active: bool, reason: str) -> Organization:
    """Suspending blocks every sign-in and ends every session of the organization; data is untouched."""
    require_operator(ctx)
    if not reason.strip():
        raise ValidationError({"reason": ["Give the reason."]})
    organization = Organization.objects.select_for_update().get(pk=organization.pk)
    organization.is_active = active
    organization.save(update_fields=["is_active", "updated_at"])
    if not active:
        from apps.identity.models import AuthSession

        for session in AuthSession.objects.filter(user__organization=organization, revoked_at__isnull=True):
            revoke_session(session, "organization_suspended", ctx)
    audit.record(
        f"platform.organization.{'reactivated' if active else 'suspended'}",
        ctx=ctx,
        resource_type="organization.organization",
        resource_id=organization.pk,
        organization_id=organization.pk,
        summary=reason[:500],
    )
    return organization


def overview(organization_ids=None):
    """Directory figures only: counts and status, never business data."""
    qs = Organization.objects.annotate(
        user_count=Count("users", distinct=True), company_count=Count("companies", distinct=True)
    ).order_by("code")
    return qs if organization_ids is None else qs.filter(pk__in=organization_ids)
