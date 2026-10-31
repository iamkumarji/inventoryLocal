from django.db import transaction
from django.utils import timezone

from apps.audit import services as audit
from apps.authorization import pdp
from apps.core.context import ActorContext
from apps.core.crypto import decrypt_str, encrypt_str
from apps.core.exceptions import AuthorizationDenied, BusinessRuleViolation, InvalidStateTransition

from .models import Partner, PartnerBankAccount


@transaction.atomic
def add_bank_account(
    ctx: ActorContext, partner: Partner, *, bank_name: str, ifsc: str, account_holder: str, account_number: str
) -> PartnerBankAccount:
    pdp.require(ctx, "partners.bank_account.update", pdp.Resource.of(partner))
    digits = "".join(ch for ch in account_number if ch.isalnum())
    if not 6 <= len(digits) <= 20:
        raise BusinessRuleViolation("Account number must have 6–20 characters.", code="invalid_account_number")
    account = PartnerBankAccount.objects.create(
        organization_id=partner.organization_id,
        partner=partner,
        bank_name=bank_name,
        ifsc=ifsc.upper(),
        account_holder=account_holder,
        account_number_encrypted=encrypt_str(digits),
        account_last4=digits[-4:],
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    audit.record(
        "partners.bank_account.added",
        ctx=ctx,
        resource_type="partners.bank_account",
        resource_id=account.pk,
        summary=f"{partner.code} {bank_name} ****{account.account_last4}",
        changes={"partner": str(partner.pk), "ifsc": account.ifsc, "last4": account.account_last4},
    )
    return account


@transaction.atomic
def review_bank_account(
    ctx: ActorContext, account: PartnerBankAccount, *, approve: bool, note: str = ""
) -> PartnerBankAccount:
    account = PartnerBankAccount.objects.select_for_update().get(pk=account.pk)
    if account.status != PartnerBankAccount.Status.PENDING:
        raise InvalidStateTransition("Only pending bank accounts can be reviewed.")
    if account.created_by_id == ctx.user_id:
        raise AuthorizationDenied(reason="maker_checker")  # whoever entered it can't verify it
    pdp.require(ctx, "partners.bank_account.approve", pdp.Resource.of(account))
    account.status = PartnerBankAccount.Status.VERIFIED if approve else PartnerBankAccount.Status.REJECTED
    account.verified_by, account.verified_at, account.review_note = ctx.user, timezone.now(), note
    account.updated_by = ctx.user
    account.save()
    if approve:  # one verified account per partner: older verified ones are retired
        PartnerBankAccount.objects.filter(partner=account.partner, status=PartnerBankAccount.Status.VERIFIED).exclude(
            pk=account.pk
        ).update(status=PartnerBankAccount.Status.RETIRED)
    audit.record(
        f"partners.bank_account.{'verified' if approve else 'rejected'}",
        ctx=ctx,
        resource_type="partners.bank_account",
        resource_id=account.pk,
        summary=note,
    )
    return account


def payable_account_number(account: PartnerBankAccount) -> str:
    """For payment file generation only (finance). Never serialize this."""
    if account.status != PartnerBankAccount.Status.VERIFIED:
        raise BusinessRuleViolation("Bank account isn't verified.", code="bank_account_unverified")
    return decrypt_str(account.account_number_encrypted)


@transaction.atomic
def approve_supplier(ctx: ActorContext, partner: Partner, *, approve: bool = True):
    """Vendor onboarding is maker-checker: the person who created the supplier can't approve it."""
    from .models import SupplierProfile

    profile = SupplierProfile.objects.select_for_update().get(partner=partner)
    if partner.created_by_id == ctx.user_id:
        raise AuthorizationDenied(reason="maker_checker")
    pdp.require(ctx, "partners.supplier.approve", pdp.Resource.of(partner))
    profile.is_approved_vendor = approve
    profile.version += 1
    profile.updated_by = ctx.user
    profile.save()
    audit.record(
        f"partners.supplier.{'approved' if approve else 'unapproved'}",
        ctx=ctx,
        resource_type="partners.partner",
        resource_id=partner.pk,
        summary=partner.name,
    )
    return profile
