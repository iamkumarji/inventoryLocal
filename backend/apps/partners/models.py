from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.fields import MoneyField, PercentField
from apps.core.models import ActorStampedModel, SharedMasterMixin, VersionedModel
from apps.organization.models import GSTIN_REGEX, PAN_REGEX


class Partner(SharedMasterMixin, VersionedModel, ActorStampedModel):
    class GstRegistration(models.TextChoices):
        REGULAR = "regular"
        COMPOSITION = "composition"
        UNREGISTERED = "unregistered"
        OVERSEAS = "overseas"
        SEZ = "sez"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    code = models.CharField(max_length=30)
    name = models.CharField(max_length=200)
    legal_name = models.CharField(max_length=250, blank=True)
    is_supplier = models.BooleanField(default=False)
    is_customer = models.BooleanField(default=False)
    gst_registration = models.CharField(max_length=15, choices=GstRegistration.choices, default=GstRegistration.REGULAR)
    gstin = models.CharField(max_length=15, blank=True)
    pan = models.CharField(max_length=10, blank=True)
    state_code = models.CharField(max_length=2, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=30, blank=True)
    is_blocked = models.BooleanField(default=False)
    blocked_reason = models.CharField(max_length=300, blank=True)
    is_active = models.BooleanField(default=True)

    authz_resource_type = "partners.partner"

    class Meta:
        db_table = "partners"
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uq_partner_code"),
            models.CheckConstraint(condition=Q(gstin="") | Q(gstin__regex=GSTIN_REGEX), name="ck_partner_gstin"),
            models.CheckConstraint(condition=Q(pan="") | Q(pan__regex=PAN_REGEX), name="ck_partner_pan"),
            models.CheckConstraint(condition=Q(is_supplier=True) | Q(is_customer=True), name="ck_partner_has_role"),
            models.CheckConstraint(
                condition=~Q(gst_registration="regular") | ~Q(gstin=""), name="ck_partner_regular_needs_gstin"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} {self.name}"


class PartnerAddress(SharedMasterMixin, ActorStampedModel):
    class Kind(models.TextChoices):
        BILLING = "billing"
        SHIPPING = "shipping"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    partner = models.ForeignKey(Partner, on_delete=models.CASCADE, related_name="addresses")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    line1 = models.CharField(max_length=200)
    line2 = models.CharField(max_length=200, blank=True)
    city = models.CharField(max_length=100)
    state_code = models.CharField(max_length=2)
    pincode = models.CharField(max_length=10)
    country = models.CharField(max_length=2, default="IN")
    is_default = models.BooleanField(default=False)

    authz_resource_type = "partners.partner"

    class Meta:
        db_table = "partner_addresses"


class PartnerContact(SharedMasterMixin, ActorStampedModel):
    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    partner = models.ForeignKey(Partner, on_delete=models.CASCADE, related_name="contacts")
    name = models.CharField(max_length=150)
    role = models.CharField(max_length=100, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=30, blank=True)

    authz_resource_type = "partners.partner"

    class Meta:
        db_table = "partner_contacts"


class PartnerBankAccount(SharedMasterMixin, ActorStampedModel):
    """Account numbers are encrypted at rest; only the last four digits are ever shown.

    A new or changed account is unusable for payments until a different user verifies it.
    """

    class Status(models.TextChoices):
        PENDING = "pending_verification"
        VERIFIED = "verified"
        REJECTED = "rejected"
        RETIRED = "retired"

    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    partner = models.ForeignKey(Partner, on_delete=models.CASCADE, related_name="bank_accounts")
    bank_name = models.CharField(max_length=150)
    ifsc = models.CharField(max_length=11)
    account_holder = models.CharField(max_length=200)
    account_number_encrypted = models.TextField()
    account_last4 = models.CharField(max_length=4)
    status = models.CharField(max_length=25, choices=Status.choices, default=Status.PENDING)
    verified_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    verified_at = models.DateTimeField(null=True, blank=True)
    review_note = models.CharField(max_length=300, blank=True)

    authz_resource_type = "partners.bank_account"

    class Meta:
        db_table = "partner_bank_accounts"
        constraints = [
            models.CheckConstraint(condition=Q(ifsc__regex=r"^[A-Z]{4}0[A-Z0-9]{6}$"), name="ck_bank_ifsc"),
            models.CheckConstraint(
                condition=Q(status__in=["pending_verification", "verified", "rejected", "retired"]),
                name="ck_bank_status",
            ),
        ]


class SupplierProfile(SharedMasterMixin, VersionedModel, ActorStampedModel):
    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    partner = models.OneToOneField(Partner, on_delete=models.CASCADE, related_name="supplier_profile")
    payment_terms_days = models.PositiveIntegerField(default=30)
    currency = models.CharField(max_length=3, default="INR")
    default_lead_time_days = models.PositiveIntegerField(default=7)
    rating = PercentField(null=True, blank=True)  # 0–100 from quality and delivery performance
    is_approved_vendor = models.BooleanField(default=False)
    tds_section = models.CharField(max_length=10, blank=True)

    authz_resource_type = "partners.supplier"

    class Meta:
        db_table = "supplier_profiles"


class CustomerProfile(SharedMasterMixin, VersionedModel, ActorStampedModel):
    organization = models.ForeignKey("organization.Organization", on_delete=models.PROTECT, related_name="+")
    partner = models.OneToOneField(Partner, on_delete=models.CASCADE, related_name="customer_profile")
    credit_limit = MoneyField(default=0)
    credit_days = models.PositiveIntegerField(default=30)
    on_credit_hold = models.BooleanField(default=False)

    authz_resource_type = "partners.customer"

    class Meta:
        db_table = "customer_profiles"
        constraints = [models.CheckConstraint(condition=Q(credit_limit__gte=0), name="ck_customer_credit_limit")]
