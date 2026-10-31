from rest_framework import serializers

from apps.partners.models import (
    CustomerProfile,
    Partner,
    PartnerAddress,
    PartnerBankAccount,
    PartnerContact,
    SupplierProfile,
)

META = ["id", "version", "created_at", "updated_at"]


class AddressSerializer(serializers.ModelSerializer):
    class Meta:
        model = PartnerAddress
        fields = ["id", "kind", "line1", "line2", "city", "state_code", "pincode", "country", "is_default"]


class ContactSerializer(serializers.ModelSerializer):
    class Meta:
        model = PartnerContact
        fields = ["id", "name", "role", "email", "phone"]


class SupplierProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = SupplierProfile
        fields = [
            "payment_terms_days",
            "currency",
            "default_lead_time_days",
            "rating",
            "is_approved_vendor",
            "tds_section",
        ]
        read_only_fields = ["rating", "is_approved_vendor"]


class CustomerProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = CustomerProfile
        fields = ["credit_limit", "credit_days", "on_credit_hold"]


class PartnerSerializer(serializers.ModelSerializer):
    addresses = AddressSerializer(many=True, read_only=True)
    contacts = ContactSerializer(many=True, read_only=True)
    supplier_profile = SupplierProfileSerializer(read_only=True)
    customer_profile = CustomerProfileSerializer(read_only=True)

    class Meta:
        model = Partner
        fields = [
            *META,
            "code",
            "name",
            "legal_name",
            "is_supplier",
            "is_customer",
            "gst_registration",
            "gstin",
            "pan",
            "state_code",
            "email",
            "phone",
            "is_blocked",
            "blocked_reason",
            "is_active",
            "addresses",
            "contacts",
            "supplier_profile",
            "customer_profile",
        ]
        read_only_fields = META


class BankAccountSerializer(serializers.ModelSerializer):
    masked_number = serializers.SerializerMethodField()

    class Meta:
        model = PartnerBankAccount
        fields = [
            "id",
            "bank_name",
            "ifsc",
            "account_holder",
            "masked_number",
            "status",
            "verified_by",
            "verified_at",
            "review_note",
            "created_by",
            "created_at",
        ]
        read_only_fields = fields

    def get_masked_number(self, obj) -> str:
        return f"****{obj.account_last4}"


class BankAccountCreateSerializer(serializers.Serializer):
    bank_name = serializers.CharField(max_length=150)
    ifsc = serializers.RegexField(r"^[A-Za-z]{4}0[A-Za-z0-9]{6}$")
    account_holder = serializers.CharField(max_length=200)
    account_number = serializers.CharField(max_length=30, write_only=True)


class ReviewSerializer(serializers.Serializer):
    approve = serializers.BooleanField()
    note = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
