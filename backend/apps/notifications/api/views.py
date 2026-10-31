from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view, inline_serializer
from rest_framework import mixins, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization.drf import ERPGenericViewSet
from apps.core.pagination import LedgerCursorPagination
from apps.notifications import services
from apps.notifications.models import Category, Channel, Notification


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = [
            "id",
            "category",
            "severity",
            "title",
            "body",
            "link",
            "resource_type",
            "resource_id",
            "read_at",
            "created_at",
        ]
        read_only_fields = fields


class PreferenceSerializer(serializers.Serializer):
    category = serializers.ChoiceField(choices=Category.choices)
    channel = serializers.ChoiceField(choices=Channel.choices)
    enabled = serializers.BooleanField()
    mandatory = serializers.BooleanField(read_only=True)


class MarkReadSerializer(serializers.Serializer):
    ids = serializers.ListField(child=serializers.UUIDField(), required=False)


UNREAD = inline_serializer("UnreadCount", {"unread_count": serializers.IntegerField()})


@extend_schema_view(
    list=extend_schema(parameters=[OpenApiParameter("unread", OpenApiTypes.BOOL, description="Only unread")])
)
class NotificationViewSet(mixins.ListModelMixin, ERPGenericViewSet):
    """The caller's own notifications (self-service)."""

    authz_authenticated_only = True
    serializer_class = NotificationSerializer
    pagination_class = LedgerCursorPagination
    filterset_fields = ["category"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Notification.objects.none()
        qs = Notification.objects.filter(recipient=self.request.user)
        if self.request.query_params.get("unread") in ("1", "true"):
            qs = qs.filter(read_at__isnull=True)
        return qs

    @extend_schema(responses=UNREAD)
    @action(detail=False, methods=["get"], url_path="unread-count")
    def unread_count(self, request):
        return Response({"unread_count": services.unread_count(request.user.pk)})

    @extend_schema(request=MarkReadSerializer, responses=UNREAD)
    @action(detail=False, methods=["post"], url_path="mark-read")
    def mark_read(self, request):
        data = MarkReadSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        services.mark_read(request.user.pk, data.validated_data.get("ids"))
        return Response({"unread_count": services.unread_count(request.user.pk)})


class NotificationPreferencesView(APIView):
    """The caller's notification preferences per category and channel (self-service)."""

    authz_authenticated_only = True

    @extend_schema(responses=PreferenceSerializer(many=True))
    def get(self, request):
        return Response(services.effective_preferences(request.user))

    @extend_schema(request=PreferenceSerializer(many=True), responses=PreferenceSerializer(many=True))
    def put(self, request):
        data = PreferenceSerializer(data=request.data, many=True)
        data.is_valid(raise_exception=True)
        services.set_preferences(request.user, data.validated_data)
        return Response(services.effective_preferences(request.user))
