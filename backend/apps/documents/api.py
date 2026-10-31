"""Documents API: record attachments and a standalone library on object storage."""

from django.http import FileResponse
from django.shortcuts import get_object_or_404
from django.urls import re_path
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter
from rest_framework.views import APIView

from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet, ScopedPrimaryKeyRelatedField
from apps.authorization.models import Role
from apps.core.exceptions import NotFound
from apps.core.idempotency import idempotent
from apps.identity.models import User
from apps.organization.models import Company

from . import services
from .models import Confidentiality, Document, DocumentACL, DocumentVersion
from .storage import content_disposition


class _OrgField(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get("request")
        queryset = super().get_queryset()
        if request is None or not getattr(request.user, "is_authenticated", False):
            return queryset.none()
        return queryset.filter(organization_id=request.user.organization_id)


class DocumentVersionSerializer(serializers.ModelSerializer):
    class Meta:
        model = DocumentVersion
        fields = ["id", "version_no", "filename", "content_type", "size", "sha256", "uploaded_by", "uploaded_at"]
        read_only_fields = fields


class DocumentSerializer(serializers.ModelSerializer):
    current_version = DocumentVersionSerializer(read_only=True)

    class Meta:
        model = Document
        fields = [
            "id",
            "version",
            "company",
            "title",
            "category",
            "description",
            "resource_type",
            "resource_id",
            "confidentiality",
            "retention_until",
            "legal_hold",
            "legal_hold_reason",
            "current_version",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class DocumentCreateSerializer(serializers.Serializer):
    file = serializers.FileField(help_text="PDF, PNG, JPEG, WEBP, XLSX, DOCX, CSV or TXT; size limit applies.")
    title = serializers.CharField(max_length=200)
    category = serializers.CharField(max_length=60, required=False, allow_blank=True, default="")
    description = serializers.CharField(required=False, allow_blank=True, default="")
    confidentiality = serializers.ChoiceField(choices=Confidentiality.choices, default=Confidentiality.INTERNAL)
    retention_until = serializers.DateField(required=False, allow_null=True, default=None)
    company = ScopedPrimaryKeyRelatedField(
        queryset=Company.objects.all(), read_action="documents.document.create", required=False
    )
    resource_type = serializers.CharField(max_length=100, required=False, allow_blank=True, default="")
    resource_id = serializers.CharField(max_length=64, required=False, allow_blank=True, default="")


class NewVersionSerializer(serializers.Serializer):
    file = serializers.FileField()
    version = serializers.IntegerField(help_text="Document version (optimistic locking).")


class MetadataSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False)
    category = serializers.CharField(max_length=60, required=False, allow_blank=True)
    description = serializers.CharField(required=False, allow_blank=True)
    confidentiality = serializers.ChoiceField(choices=Confidentiality.choices, required=False)
    version = serializers.IntegerField()


class LegalHoldSerializer(serializers.Serializer):
    legal_hold = serializers.BooleanField()
    reason = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    version = serializers.IntegerField()


class RetentionSerializer(serializers.Serializer):
    retention_until = serializers.DateField(allow_null=True)
    version = serializers.IntegerField()


class DownloadRequestSerializer(serializers.Serializer):
    version_no = serializers.IntegerField(required=False, min_value=1, help_text="Defaults to the current version.")


class DownloadSerializer(serializers.Serializer):
    url = serializers.CharField()
    expires_at = serializers.DateTimeField()
    version_no = serializers.IntegerField()
    filename = serializers.CharField()
    content_type = serializers.CharField()
    size = serializers.IntegerField()
    sha256 = serializers.CharField()


class AclSerializer(serializers.ModelSerializer):
    user = _OrgField(queryset=User.objects.filter(is_active=True), required=False, allow_null=True)
    role = _OrgField(queryset=Role.objects.filter(is_active=True), required=False, allow_null=True)

    class Meta:
        model = DocumentACL
        fields = ["id", "user", "role", "permission", "granted_by", "granted_at"]
        read_only_fields = ["id", "granted_by", "granted_at"]


RECORD_FILTERS = [
    OpenApiParameter("resource_type", OpenApiTypes.STR, description="With resource_id: attachments of that record"),
    OpenApiParameter("resource_id", OpenApiTypes.STR),
    OpenApiParameter("category", OpenApiTypes.STR),
]
ACL_ID = OpenApiParameter("acl_id", OpenApiTypes.UUID, OpenApiParameter.PATH)
MULTIPART = (MultiPartParser, FormParser)


class DocumentViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    """Documents. Readability is checked per object (record delegation + confidentiality ACL); a document
    the caller can't read answers 404."""

    authz_resource = services.DOC
    authz_actions = {
        "versions": "read",
        "add_version": "update",
        "download": "download",
        "legal_hold": "manage",
        "retention": "manage",
        "acl": "share",
        "revoke_acl": "share",
    }
    queryset = Document.objects.select_related("current_version").order_by("-created_at")
    serializer_class = DocumentSerializer
    parser_classes = (JSONParser, *MULTIPART)
    filter_backends: list = []

    def get_object(self):
        doc = get_object_or_404(self.get_queryset(), pk=self.kwargs["pk"])
        # Readability (404) here; the action's own verb is checked by the service.
        services.require_access(self.actor, doc, "read")
        return doc

    def _respond(self, doc, code=status.HTTP_200_OK):
        fresh = Document.objects.select_related("current_version").get(pk=doc.pk)
        return Response(DocumentSerializer(fresh).data, status=code)

    def _validated(self, serializer_cls):
        data = serializer_cls(data=self.request.data, context=self.get_serializer_context())
        data.is_valid(raise_exception=True)
        return dict(data.validated_data)

    @extend_schema(parameters=RECORD_FILTERS)
    def list(self, request, *args, **kwargs):
        params = request.query_params
        queryset = services.visible_documents(
            self.actor, self.get_queryset(), params.get("resource_type", ""), params.get("resource_id", "")
        )
        if params.get("category"):
            queryset = queryset.filter(category=params["category"])
        page = self.paginate_queryset(queryset)
        return self.get_paginated_response(DocumentSerializer(page, many=True).data)

    @extend_schema(request={"multipart/form-data": DocumentCreateSerializer}, responses={201: DocumentSerializer})
    @idempotent()
    def create(self, request):
        v = self._validated(DocumentCreateSerializer)
        upload = v.pop("file")
        doc = services.create_document(self.actor, upload=upload, declared_type=upload.content_type, **v)
        return self._respond(doc, status.HTTP_201_CREATED)

    @extend_schema(request=MetadataSerializer, responses=DocumentSerializer, description="Edit metadata.")
    def partial_update(self, request, pk=None):
        doc = self.get_object()
        v = self._validated(MetadataSerializer)
        version = v.pop("version")
        return self._respond(services.update_metadata(self.actor, doc, v, version))

    @extend_schema(
        responses={204: None},
        description="Allowed only past `retention_until` and when no legal hold applies.",
    )
    def destroy(self, request, pk=None):
        services.delete_document(self.actor, self.get_object())
        return Response(status=status.HTTP_204_NO_CONTENT)

    @extend_schema(responses=DocumentVersionSerializer(many=True))
    @action(detail=True, methods=["get"], pagination_class=None)
    def versions(self, request, pk=None):
        doc = self.get_object()
        return Response(DocumentVersionSerializer(doc.versions.order_by("-version_no"), many=True).data)

    @extend_schema(request={"multipart/form-data": NewVersionSerializer}, responses={201: DocumentSerializer})
    @versions.mapping.post
    def add_version(self, request, pk=None):
        doc = self.get_object()
        v = self._validated(NewVersionSerializer)
        doc = services.add_version(self.actor, doc, v["file"], v["version"], declared_type=v["file"].content_type)
        return self._respond(doc, status.HTTP_201_CREATED)

    @extend_schema(
        request=DownloadRequestSerializer,
        responses=DownloadSerializer,
        description="Short-lived (≤ 5 min) download URL. Every request is audited.",
    )
    @action(detail=True, methods=["post"])
    def download(self, request, pk=None):
        doc = self.get_object()
        v = self._validated(DownloadRequestSerializer)
        version = None
        if v.get("version_no"):
            version = doc.versions.filter(version_no=v["version_no"]).first()
            if version is None:
                raise NotFound("Version not found.")
        return Response(DownloadSerializer(services.issue_download(self.actor, doc, version)).data)

    @extend_schema(request=LegalHoldSerializer, responses=DocumentSerializer)
    @action(detail=True, methods=["post"], url_path="legal-hold")
    def legal_hold(self, request, pk=None):
        doc = self.get_object()
        v = self._validated(LegalHoldSerializer)
        return self._respond(services.set_legal_hold(self.actor, doc, v["legal_hold"], v["reason"], v["version"]))

    @extend_schema(request=RetentionSerializer, responses=DocumentSerializer)
    @action(detail=True, methods=["post"])
    def retention(self, request, pk=None):
        doc = self.get_object()
        v = self._validated(RetentionSerializer)
        return self._respond(services.set_retention(self.actor, doc, v["retention_until"], v["version"]))

    @extend_schema(methods=["GET"], request=None, responses=AclSerializer(many=True))
    @extend_schema(methods=["POST"], request=AclSerializer, responses={201: AclSerializer})
    @action(detail=True, methods=["get", "post"], pagination_class=None)
    def acl(self, request, pk=None):
        doc = self.get_object()
        if request.method == "GET":
            return Response(AclSerializer(services.list_acl(self.actor, doc), many=True).data)
        v = self._validated(AclSerializer)
        acl = services.grant_acl(self.actor, doc, permission=v["permission"], user=v.get("user"), role=v.get("role"))
        return Response(AclSerializer(acl).data, status=status.HTTP_201_CREATED)

    @extend_schema(parameters=[ACL_ID], request=None, responses={204: None})
    @action(detail=True, methods=["delete"], url_path=r"acl/(?P<acl_id>[0-9a-fA-F-]{32,36})")
    def revoke_acl(self, request, pk=None, acl_id=None):
        services.revoke_acl(self.actor, self.get_object(), acl_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class DocumentFileView(APIView):
    """Serves local-backend content for a signed, expiring, user-bound token (issued by `download`)."""

    authz_authenticated_only = True  # the token is bound to the caller; access is re-checked on use

    @extend_schema(
        parameters=[OpenApiParameter("token", OpenApiTypes.STR, OpenApiParameter.PATH)],
        responses={(200, "application/octet-stream"): OpenApiResponse(OpenApiTypes.BINARY)},
    )
    def get(self, request, token: str):
        version, backend = services.resolve_download_token(actor_for(request), token)
        response = FileResponse(backend.open(version.object_key), content_type=version.content_type)
        response["Content-Disposition"] = content_disposition(version.filename)
        response["Content-Length"] = str(version.size)
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "private, no-store"
        response["Content-Security-Policy"] = "default-src 'none'; sandbox"
        return response


router = SimpleRouter()
router.register("documents/documents", DocumentViewSet, basename="document")
urlpatterns = [
    *router.urls,
    re_path(r"^documents/files/(?P<token>[A-Za-z0-9_.\-]+)/$", DocumentFileView.as_view(), name="documents-file"),
]
