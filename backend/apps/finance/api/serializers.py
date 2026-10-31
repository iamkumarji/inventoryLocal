from rest_framework import serializers

from apps.authorization.drf import ScopedPrimaryKeyRelatedField
from apps.finance.models import Account, AccountDetermination, CostCenter, JournalEntry, JournalLine
from apps.organization.models import Company

META = ["id", "version", "created_at", "updated_at"]


class AccountSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="finance.account.read")

    class Meta:
        model = Account
        fields = [
            *META,
            "company",
            "code",
            "name",
            "account_type",
            "sub_type",
            "parent",
            "is_group",
            "is_control",
            "is_active",
        ]
        read_only_fields = META
        validators: list = []


class CostCenterSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="finance.cost_center.read")

    class Meta:
        model = CostCenter
        fields = [*META, "company", "code", "name", "parent", "department", "is_active"]
        read_only_fields = META
        validators: list = []


class PostingRuleSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="finance.posting_rule.read")
    account_code = serializers.CharField(source="account.code", read_only=True)

    class Meta:
        model = AccountDetermination
        fields = ["id", "company", "key", "posting_group", "warehouse_type", "account", "account_code", "is_active"]
        validators: list = []


class JournalLineSerializer(serializers.ModelSerializer):
    account_code = serializers.CharField(source="account.code", read_only=True)
    account_name = serializers.CharField(source="account.name", read_only=True)
    partner_name = serializers.CharField(source="partner.name", read_only=True, default=None)

    class Meta:
        model = JournalLine
        fields = [
            "line_no",
            "account",
            "account_code",
            "account_name",
            "debit",
            "credit",
            "cost_center",
            "partner",
            "partner_name",
            "item",
            "warehouse",
            "description",
        ]
        read_only_fields = fields


class JournalEntrySerializer(serializers.ModelSerializer):
    lines = JournalLineSerializer(many=True, read_only=True)

    class Meta:
        model = JournalEntry
        fields = [
            "id",
            "company",
            "number",
            "entry_date",
            "source_module",
            "source_type",
            "source_id",
            "narration",
            "status",
            "total",
            "posted_at",
            "posted_by",
            "is_reversal",
            "reverses",
            "reversed_by",
            "version",
            "created_by",
            "lines",
        ]
        read_only_fields = fields


class ManualLineSerializer(serializers.Serializer):
    account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.filter(is_active=True, is_group=False))
    debit = serializers.DecimalField(max_digits=20, decimal_places=4, default=0, min_value=0)
    credit = serializers.DecimalField(max_digits=20, decimal_places=4, default=0, min_value=0)
    cost_center = serializers.PrimaryKeyRelatedField(queryset=CostCenter.objects.all(), required=False, allow_null=True)
    partner = serializers.UUIDField(required=False, allow_null=True)
    description = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")

    def validate(self, attrs):
        if (attrs["debit"] > 0) == (attrs["credit"] > 0):
            raise serializers.ValidationError("Enter either a debit or a credit on each line.")
        return attrs


class ManualJournalSerializer(serializers.Serializer):
    company = ScopedPrimaryKeyRelatedField(queryset=Company.objects.all(), read_action="finance.journal_entry.read")
    entry_date = serializers.DateField()
    narration = serializers.CharField(max_length=500)
    lines = ManualLineSerializer(many=True)


class JournalVersionSerializer(serializers.Serializer):
    version = serializers.IntegerField(required=False)


class ReverseSerializer(serializers.Serializer):
    reversal_date = serializers.DateField()
    reason = serializers.CharField(max_length=300)


class PeriodQuery(serializers.Serializer):
    date_from = serializers.DateField()
    date_to = serializers.DateField()
