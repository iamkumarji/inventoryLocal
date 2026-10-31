"""Document management: record-delegated access, confidentiality ACLs, append-only versions, short-lived
download URLs, retention and legal hold.

Access model (every check also goes through the PDP):
- baseline: `documents.document.<verb>` on the document (company scope) AND, for a record-linked document,
  `<resource_type>.read` on the linked record (apps/collaboration/records.py);
- internal: baseline;
- restricted: baseline AND (linked to a record OR creator OR an ACL entry) -- need to know;
- confidential: baseline AND an explicit ACL entry, even for users who can read the linked record.
Write-type verbs on restricted (unlinked) and confidential documents need a `write` ACL entry.
A caller who cannot read a document gets 404, never 403.
"""

from __future__ import annotations

from datetime import date, timedelta

from django.db import transaction
from django.db.models import Exists, OuterRef, Q, QuerySet
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import ValidationError

from apps.audit import services as audit
from apps.authorization import pdp
from apps.authorization.models import RoleAssignment
from apps.authorization.snapshot import get_snapshot
from apps.collaboration import records
from apps.core.context import ActorContext
from apps.core.exceptions import (
    AuthorizationDenied,
    BusinessRuleViolation,
    DomainError,
    MFARequired,
    NotFound,
    VersionConflict,
)
from apps.core.ids import uuid7
from apps.core.outbox import publish_event

from . import storage as storage_mod
from . import uploads
from .models import Confidentiality, Document, DocumentACL, DocumentVersion

DOC = "documents.document"
METADATA_FIELDS = ("title", "category", "description", "confidentiality")
_RANK = {Confidentiality.INTERNAL: 0, Confidentiality.RESTRICTED: 1, Confidentiality.CONFIDENTIAL: 2}


class DownloadLinkInvalid(DomainError):
    status_code = status.HTTP_403_FORBIDDEN
    type = "download_link_invalid"
    title = "This download link is invalid or has expired. Request a new one."


def _check_version(doc: Document, expected_version: int | None) -> None:
    if expected_version is None or doc.version != expected_version:
        raise VersionConflict()


# --- Access ----------------------------------------------------------------------------------------


def active_role_ids(user) -> set:
    now = timezone.now()
    return set(
        RoleAssignment.objects.filter(user=user, revoked_at__isnull=True, role__is_active=True)
        .filter(Q(valid_from__isnull=True) | Q(valid_from__lte=now))
        .filter(Q(valid_until__isnull=True) | Q(valid_until__gt=now))
        .values_list("role_id", flat=True)
    )


def acl_level(user, doc: Document) -> str | None:
    levels = set(
        DocumentACL.objects.filter(document=doc)
        .filter(Q(user=user) | Q(role_id__in=active_role_ids(user)))
        .values_list("permission", flat=True)
    )
    if DocumentACL.Permission.WRITE in levels:
        return DocumentACL.Permission.WRITE
    return DocumentACL.Permission.READ if levels else None


def _acl_allows(level: str | None, need: str) -> bool:
    return level == DocumentACL.Permission.WRITE or (level == DocumentACL.Permission.READ and need == "read")


def _confidentiality_ok(ctx: ActorContext, doc: Document, need: str) -> bool:
    if doc.confidentiality == Confidentiality.CONFIDENTIAL:
        return _acl_allows(acl_level(ctx.user, doc), need)
    if doc.confidentiality == Confidentiality.RESTRICTED and not doc.resource_type:
        return doc.created_by_id == ctx.user_id or _acl_allows(acl_level(ctx.user, doc), need)
    return True


def _record_ok(ctx: ActorContext, doc: Document) -> bool:
    if not doc.resource_type:
        return True
    try:
        records.resolve(ctx, doc.resource_type, doc.resource_id)
    except NotFound:
        return False
    return True


def require_access(ctx: ActorContext, doc: Document, verb: str) -> None:
    """Raise NotFound when the document isn't readable, AuthorizationDenied when `verb` isn't allowed."""
    decision = pdp.authorize(ctx, f"{DOC}.read", pdp.Resource.of(doc))
    if not decision.allowed:
        if decision.reason == "mfa_required":
            raise MFARequired()
        raise NotFound("Document not found.")
    if not _record_ok(ctx, doc) or not _confidentiality_ok(ctx, doc, "read"):
        raise NotFound("Document not found.")
    if verb == "read":
        return
    pdp.require(ctx, f"{DOC}.{verb}", pdp.Resource.of(doc))
    if verb != "download" and not _confidentiality_ok(ctx, doc, "write"):
        raise AuthorizationDenied("document_acl")


def visible_documents(
    ctx: ActorContext, queryset: QuerySet, resource_type: str = "", resource_id: str = ""
) -> QuerySet:
    """Row filter mirroring `require_access(..., "read")`. `queryset` must already be PDP-filtered.

    With a record reference: documents attached to that record (404 if the record isn't readable).
    Without: the standalone library (documents not linked to a record).
    """
    if resource_type or resource_id:
        record = records.resolve(ctx, resource_type, resource_id)
        queryset = queryset.filter(resource_type=resource_type, resource_id=str(record.pk))
    else:
        queryset = queryset.filter(resource_type="")
    has_acl = Exists(
        DocumentACL.objects.filter(document=OuterRef("pk")).filter(
            Q(user_id=ctx.user_id) | Q(role_id__in=active_role_ids(ctx.user))
        )
    )
    return queryset.filter(
        Q(confidentiality=Confidentiality.INTERNAL)
        | (
            Q(confidentiality=Confidentiality.RESTRICTED)
            & (~Q(resource_type="") | Q(created_by_id=ctx.user_id) | Q(has_acl))
        )
        | (Q(confidentiality=Confidentiality.CONFIDENTIAL) & Q(has_acl))
    )


# --- Create and version ----------------------------------------------------------------------------


def _store_version(ctx: ActorContext, doc: Document, upload, validated: uploads.ValidatedUpload) -> DocumentVersion:
    last = doc.versions.order_by("-version_no").values_list("version_no", flat=True).first() or 0
    version_id = uuid7()
    key = f"{doc.company_id}/documents/{doc.pk}/{version_id}"
    backend = storage_mod.get_storage()
    backend.put(key, upload, content_type=validated.content_type, size=validated.size)
    try:
        with transaction.atomic():
            version = DocumentVersion.objects.create(
                id=version_id,
                document=doc,
                version_no=last + 1,
                object_key=key,
                filename=validated.filename,
                content_type=validated.content_type,
                size=validated.size,
                sha256=validated.sha256,
                uploaded_by=ctx.user,
                uploaded_at=timezone.now(),
            )
    except Exception:
        backend.delete(key)
        raise
    return version


def _version_summary(version: DocumentVersion) -> dict:
    return {
        "version_no": version.version_no,
        "filename": version.filename,
        "content_type": version.content_type,
        "size": version.size,
        "sha256": version.sha256,
    }


@transaction.atomic
def create_document(
    ctx: ActorContext,
    *,
    upload,
    title: str,
    category: str = "",
    description: str = "",
    confidentiality: str = Confidentiality.INTERNAL,
    retention_until: date | None = None,
    company=None,
    resource_type: str = "",
    resource_id: str = "",
    declared_type: str | None = None,
) -> Document:
    record_company, record_id = None, ""
    if resource_type or resource_id:
        if not (resource_type and resource_id):
            raise ValidationError({"resource_id": ["Give both resource_type and resource_id."]})
        if resource_type == DOC:
            raise ValidationError({"resource_type": ["Documents can't be attached to documents."]})
        record = records.resolve(ctx, resource_type, resource_id)
        record_company, record_id = records.record_company_id(record), str(record.pk)
    company_id = company.pk if company is not None else (record_company or ctx.company_id)
    if company_id is None:
        raise ValidationError({"company": ["Select a company."]})
    if record_company is not None and record_company != company_id:
        raise ValidationError({"company": ["The document must belong to the linked record's company."]})
    pdp.require(ctx, f"{DOC}.create", pdp.Resource.ref(DOC, company_id=company_id))
    validated = uploads.validate(upload, declared_type)
    doc = Document.objects.create(
        company_id=company_id,
        title=title,
        category=category,
        description=description,
        confidentiality=confidentiality,
        retention_until=retention_until,
        resource_type=resource_type if record_id else "",
        resource_id=record_id,
        created_by=ctx.user,
        updated_by=ctx.user,
    )
    if confidentiality == Confidentiality.CONFIDENTIAL:
        DocumentACL.objects.create(
            document=doc, user=ctx.user, permission=DocumentACL.Permission.WRITE, granted_by=ctx.user
        )
    version = _store_version(ctx, doc, upload, validated)
    doc.current_version = version
    doc.save(update_fields=["current_version"])
    audit.record(
        f"{DOC}.created",
        ctx=ctx,
        resource_type=DOC,
        resource_id=doc.pk,
        company_id=company_id,
        summary=doc.title,
        changes={
            "after": {
                **audit.snapshot(doc, ("title", "category", "confidentiality", "resource_type", "resource_id")),
                **_version_summary(version),
            }
        },
    )
    publish_event(
        f"{DOC}.created",
        aggregate_type=DOC,
        aggregate_id=doc.pk,
        company_id=company_id,
        payload={"resource_type": doc.resource_type, "resource_id": doc.resource_id},
    )
    return doc


@transaction.atomic
def add_version(ctx: ActorContext, doc: Document, upload, expected_version: int | None, declared_type=None):
    doc = Document.objects.select_for_update().get(pk=doc.pk)
    require_access(ctx, doc, "update")
    _check_version(doc, expected_version)
    validated = uploads.validate(upload, declared_type)
    version = _store_version(ctx, doc, upload, validated)
    doc.current_version = version
    doc.version += 1
    doc.updated_by = ctx.user
    doc.save(update_fields=["current_version", "version", "updated_by", "updated_at"])
    audit.record(
        f"{DOC}.version_added",
        ctx=ctx,
        resource_type=DOC,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=f"{doc.title} v{version.version_no}",
        changes=_version_summary(version),
    )
    publish_event(
        f"{DOC}.version_added",
        aggregate_type=DOC,
        aggregate_id=doc.pk,
        company_id=doc.company_id,
        payload={"version_no": version.version_no},
    )
    return doc


# --- Metadata, retention and legal hold ------------------------------------------------------------


@transaction.atomic
def update_metadata(ctx: ActorContext, doc: Document, data: dict, expected_version: int | None) -> Document:
    doc = Document.objects.select_for_update().get(pk=doc.pk)
    require_access(ctx, doc, "update")
    _check_version(doc, expected_version)
    unknown = set(data) - set(METADATA_FIELDS)
    if unknown:
        raise ValidationError({field: ["This field cannot be changed."] for field in sorted(unknown)})
    new_level = data.get("confidentiality", doc.confidentiality)
    if _RANK[new_level] < _RANK[doc.confidentiality]:
        pdp.require(ctx, f"{DOC}.manage", pdp.Resource.of(doc))  # declassification is a compliance decision
    before = audit.snapshot(doc, METADATA_FIELDS)
    for key, value in data.items():
        setattr(doc, key, value)
    if new_level == Confidentiality.CONFIDENTIAL and acl_level(ctx.user, doc) != DocumentACL.Permission.WRITE:
        DocumentACL.objects.update_or_create(
            document=doc, user=ctx.user, defaults={"permission": DocumentACL.Permission.WRITE, "granted_by": ctx.user}
        )
    doc.version += 1
    doc.updated_by = ctx.user
    doc.save()
    changes = audit.diff(before, audit.snapshot(doc, METADATA_FIELDS))
    if changes:
        audit.record(
            f"{DOC}.updated",
            ctx=ctx,
            resource_type=DOC,
            resource_id=doc.pk,
            company_id=doc.company_id,
            summary=doc.title,
            changes=changes,
        )
    return doc


@transaction.atomic
def set_legal_hold(ctx: ActorContext, doc: Document, hold: bool, reason: str, expected_version: int | None):
    doc = Document.objects.select_for_update().get(pk=doc.pk)
    require_access(ctx, doc, "manage")
    _check_version(doc, expected_version)
    if hold and not reason.strip():
        raise ValidationError({"reason": ["Give the reason for the legal hold."]})
    before = {"legal_hold": doc.legal_hold, "legal_hold_reason": doc.legal_hold_reason}
    doc.legal_hold = hold
    doc.legal_hold_reason = reason.strip() if hold else ""
    doc.version += 1
    doc.updated_by = ctx.user
    doc.save(update_fields=["legal_hold", "legal_hold_reason", "version", "updated_by", "updated_at"])
    audit.record(
        f"{DOC}.legal_hold_{'placed' if hold else 'released'}",
        ctx=ctx,
        resource_type=DOC,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=doc.title,
        changes=audit.diff(before, {"legal_hold": doc.legal_hold, "legal_hold_reason": doc.legal_hold_reason}),
    )
    return doc


@transaction.atomic
def set_retention(ctx: ActorContext, doc: Document, retention_until: date | None, expected_version: int | None):
    doc = Document.objects.select_for_update().get(pk=doc.pk)
    require_access(ctx, doc, "manage")
    _check_version(doc, expected_version)
    before = audit.snapshot(doc, ("retention_until",))
    doc.retention_until = retention_until
    doc.version += 1
    doc.updated_by = ctx.user
    doc.save(update_fields=["retention_until", "version", "updated_by", "updated_at"])
    audit.record(
        f"{DOC}.retention_changed",
        ctx=ctx,
        resource_type=DOC,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=doc.title,
        changes=audit.diff(before, audit.snapshot(doc, ("retention_until",))),
    )
    return doc


@transaction.atomic
def delete_document(ctx: ActorContext, doc: Document) -> None:
    """Delete a document and its content. Blocked by legal hold and until the retention date has passed."""
    doc = Document.objects.select_for_update().get(pk=doc.pk)
    require_access(ctx, doc, "delete")
    if doc.legal_hold:
        raise BusinessRuleViolation("The document is under legal hold.", code="legal_hold")
    if doc.retention_until is not None and timezone.localdate() <= doc.retention_until:
        raise BusinessRuleViolation(
            f"The document must be retained until {doc.retention_until:%d %b %Y}.", code="retention_period"
        )
    versions = list(doc.versions.all())
    audit.record(
        f"{DOC}.deleted",
        ctx=ctx,
        resource_type=DOC,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=doc.title,
        changes={
            "before": {
                **audit.snapshot(doc, ("title", "category", "confidentiality", "resource_type", "resource_id")),
                "versions": [_version_summary(v) for v in versions],
            }
        },
    )
    keys = [v.object_key for v in versions]
    doc.delete()
    backend = storage_mod.get_storage()
    transaction.on_commit(lambda: [backend.delete(key) for key in keys])


# --- Downloads -------------------------------------------------------------------------------------


@transaction.atomic
def issue_download(ctx: ActorContext, doc: Document, version: DocumentVersion | None = None) -> dict:
    require_access(ctx, doc, "download")
    version = version or doc.current_version
    if version is None or version.document_id != doc.pk:
        raise NotFound("Version not found.")
    ttl = storage_mod.url_ttl()
    url = storage_mod.get_storage().presigned_get(
        version.object_key,
        filename=version.filename,
        content_type=version.content_type,
        expires_in=ttl,
        subject_id=str(ctx.user_id),
    )
    audit.record(
        f"{DOC}.downloaded",
        ctx=ctx,
        resource_type=DOC,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=f"{doc.title} v{version.version_no}",
        changes={"version_no": version.version_no, "sha256": version.sha256},
    )
    return {
        "url": url,
        "expires_at": timezone.now() + timedelta(seconds=ttl),
        **_version_summary(version),
    }


def resolve_download_token(ctx: ActorContext, token: str) -> tuple[DocumentVersion, storage_mod.LocalFileStorage]:
    """Validate a local-backend download token for the calling user and re-check access."""
    backend = storage_mod.get_storage()
    if not isinstance(backend, storage_mod.LocalFileStorage):
        raise DownloadLinkInvalid()
    try:
        payload = backend.read_token(token)
    except storage_mod.InvalidToken as exc:
        raise DownloadLinkInvalid(code=f"download_link_{exc}") from None
    if ctx.user_id is None or payload.get("u") != str(ctx.user_id):
        raise DownloadLinkInvalid()
    version = DocumentVersion.objects.select_related("document").filter(object_key=payload["k"]).first()
    if version is None:
        raise DownloadLinkInvalid()
    doc = version.document
    if doc.company_id not in get_snapshot(ctx.user_id).companies:
        raise DownloadLinkInvalid()
    # Access may have been revoked since the link was issued (links live at most 5 minutes).
    require_access(ctx.with_company(doc.company_id), doc, "download")
    return version, backend


# --- ACL -------------------------------------------------------------------------------------------


def list_acl(ctx: ActorContext, doc: Document) -> QuerySet:
    require_access(ctx, doc, "share")
    return doc.acl.select_related("user", "role").order_by("granted_at")


@transaction.atomic
def grant_acl(ctx: ActorContext, doc: Document, *, permission: str, user=None, role=None) -> DocumentACL:
    doc = Document.objects.select_for_update().get(pk=doc.pk)
    require_access(ctx, doc, "share")
    if (user is None) == (role is None):
        raise ValidationError({"user": ["Grant to exactly one user or one role."]})
    org_id = ctx.user.organization_id
    if user is not None and (user.organization_id != org_id or not user.is_active):
        raise ValidationError({"user": ["Unknown or inactive user."]})
    if role is not None and role.organization_id != org_id:
        raise ValidationError({"role": ["Unknown role."]})
    lookup = {"user": user} if user is not None else {"role": role}
    acl, created = DocumentACL.objects.update_or_create(
        document=doc, **lookup, defaults={"permission": permission, "granted_by": ctx.user}
    )
    audit.record(
        f"{DOC}.acl_granted",
        ctx=ctx,
        resource_type=DOC,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=doc.title,
        changes={
            "user": str(user.pk) if user else None,
            "role": role.code if role else None,
            "permission": permission,
            "created": created,
        },
    )
    return acl


@transaction.atomic
def revoke_acl(ctx: ActorContext, doc: Document, acl_id) -> None:
    doc = Document.objects.select_for_update().get(pk=doc.pk)
    require_access(ctx, doc, "share")
    acl = doc.acl.filter(pk=acl_id).first()
    if acl is None:
        raise NotFound("ACL entry not found.")
    if (
        doc.confidentiality == Confidentiality.CONFIDENTIAL
        and acl.permission == DocumentACL.Permission.WRITE
        and not doc.acl.filter(permission=DocumentACL.Permission.WRITE).exclude(pk=acl.pk).exists()
    ):
        raise BusinessRuleViolation("A confidential document needs at least one writer.", code="last_writer")
    audit.record(
        f"{DOC}.acl_revoked",
        ctx=ctx,
        resource_type=DOC,
        resource_id=doc.pk,
        company_id=doc.company_id,
        summary=doc.title,
        changes={"user": str(acl.user_id) if acl.user_id else None, "role": str(acl.role_id) if acl.role_id else None},
    )
    acl.delete()
