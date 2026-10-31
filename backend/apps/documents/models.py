from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import CompanyScopedModel, UUIDModel, VersionedModel


class Confidentiality(models.TextChoices):
    INTERNAL = "internal"  # anyone with document access (and access to the linked record)
    RESTRICTED = "restricted"  # need to know: linked-record readers, the creator or an ACL entry
    CONFIDENTIAL = "confidential"  # explicit ACL entry always required


class Document(CompanyScopedModel, VersionedModel):
    title = models.CharField(max_length=200)
    category = models.CharField(max_length=60, blank=True)
    description = models.TextField(blank=True)
    resource_type = models.CharField(max_length=100, blank=True)
    resource_id = models.CharField(max_length=64, blank=True)
    confidentiality = models.CharField(max_length=15, choices=Confidentiality.choices, default=Confidentiality.INTERNAL)
    retention_until = models.DateField(null=True, blank=True)
    legal_hold = models.BooleanField(default=False)
    legal_hold_reason = models.CharField(max_length=300, blank=True)
    current_version = models.ForeignKey(
        "DocumentVersion", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    authz_resource_type = "documents.document"

    class Meta:
        db_table = "documents"
        constraints = [
            models.CheckConstraint(
                condition=Q(confidentiality__in=["internal", "restricted", "confidential"]),
                name="ck_document_confidentiality",
            ),
            models.CheckConstraint(
                condition=(Q(resource_type="") & Q(resource_id="")) | (~Q(resource_type="") & ~Q(resource_id="")),
                name="ck_document_record_ref",
            ),
        ]
        indexes = [
            models.Index(fields=["resource_type", "resource_id"], name="ix_document_record"),
            models.Index(fields=["company", "category"], name="ix_document_category"),
        ]

    def __str__(self) -> str:
        return self.title

    def authz_record_read_check(self, ctx) -> None:
        """Used when a document is the target of a generic reference (e.g. comments on a document)."""
        from .services import require_access

        require_access(ctx, self, "read")


class DocumentVersion(UUIDModel):
    """Append-only: a new upload is always a new row and a new object key (UPDATE blocked by a trigger)."""

    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="versions")
    version_no = models.PositiveIntegerField()
    object_key = models.CharField(max_length=300, unique=True)
    filename = models.CharField(max_length=200)
    content_type = models.CharField(max_length=120)
    size = models.PositiveBigIntegerField()
    sha256 = models.CharField(max_length=64)
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    uploaded_at = models.DateTimeField()

    class Meta:
        db_table = "document_versions"
        constraints = [models.UniqueConstraint(fields=["document", "version_no"], name="uq_document_version_no")]
        ordering = ["-version_no"]


class DocumentACL(UUIDModel):
    """Explicit grant on one document to a user or to the holders of a role."""

    class Permission(models.TextChoices):
        READ = "read"
        WRITE = "write"  # implies read

    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="acl")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="+"
    )
    role = models.ForeignKey("authorization.Role", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    permission = models.CharField(max_length=5, choices=Permission.choices, default=Permission.READ)
    granted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    granted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "document_acl"
        constraints = [
            models.CheckConstraint(
                condition=(Q(user__isnull=False) & Q(role__isnull=True))
                | (Q(user__isnull=True) & Q(role__isnull=False)),
                name="ck_document_acl_subject",
            ),
            models.CheckConstraint(condition=Q(permission__in=["read", "write"]), name="ck_document_acl_permission"),
            models.UniqueConstraint(
                fields=["document", "user"], name="uq_document_acl_user", condition=Q(user__isnull=False)
            ),
            models.UniqueConstraint(
                fields=["document", "role"], name="uq_document_acl_role", condition=Q(role__isnull=False)
            ),
        ]
