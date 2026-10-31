from rest_framework import serializers

from apps.audit.models import AuditEvent


class AuditEventSerializer(serializers.ModelSerializer):
    sealed = serializers.SerializerMethodField()

    class Meta:
        model = AuditEvent
        fields = [
            "id",
            "occurred_at",
            "organization_id",
            "company_id",
            "actor_id",
            "actor_type",
            "actor_label",
            "action",
            "resource_type",
            "resource_id",
            "summary",
            "changes",
            "outcome",
            "request_id",
            "ip",
            "user_agent",
            "content_hash",
            "sealed",
        ]
        read_only_fields = fields

    def get_sealed(self, obj) -> bool:
        return hasattr(obj, "seal")
