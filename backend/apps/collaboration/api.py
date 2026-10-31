"""Collaboration API: tasks, my tasks, comments on records, record activity and escalation rules."""

from django.shortcuts import get_object_or_404
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.routers import SimpleRouter

from apps.authorization.context import actor_for
from apps.authorization.drf import ERPGenericViewSet, ScopedPrimaryKeyRelatedField
from apps.authorization.models import Role
from apps.identity.models import User
from apps.organization.models import Company, Department
from apps.shared.docviews import DocumentViewSet, VersionBody
from apps.shared.viewsets import MasterDataViewSet, master_schema

from . import services
from .models import Comment, EscalationRule, Task

# --- Fields ----------------------------------------------------------------------------------------


class _OrgScopedField(serializers.PrimaryKeyRelatedField):
    """FK input limited to rows of the caller's organization (others read as 'does not exist')."""

    org_path = "organization_id"

    def get_queryset(self):
        request = self.context.get("request")
        queryset = super().get_queryset()
        if request is None or not getattr(request.user, "is_authenticated", False):
            return queryset.none()
        return queryset.filter(**{self.org_path: request.user.organization_id})


class OrgUserField(_OrgScopedField):
    def __init__(self, **kwargs):
        super().__init__(queryset=User.objects.filter(is_active=True), **kwargs)


class OrgDepartmentField(_OrgScopedField):
    org_path = "company__organization_id"

    def __init__(self, **kwargs):
        super().__init__(queryset=Department.objects.filter(is_active=True), **kwargs)


class OrgRoleField(_OrgScopedField):
    def __init__(self, **kwargs):
        super().__init__(queryset=Role.objects.filter(is_active=True), **kwargs)


# --- Tasks -----------------------------------------------------------------------------------------


class TaskSerializer(serializers.ModelSerializer):
    assignee_name = serializers.CharField(source="assignee.full_name", read_only=True, default=None)

    class Meta:
        model = Task
        fields = [
            "id",
            "version",
            "company",
            "title",
            "description",
            "priority",
            "due_at",
            "status",
            "assignee",
            "assignee_name",
            "department",
            "resource_type",
            "resource_id",
            "completed_at",
            "escalated_at",
            "escalation_count",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class TaskCreateSerializer(serializers.Serializer):
    company = ScopedPrimaryKeyRelatedField(
        queryset=Company.objects.all(), read_action="collaboration.task.create", required=False
    )
    title = serializers.CharField(max_length=200)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    priority = serializers.ChoiceField(choices=Task.Priority.choices, default=Task.Priority.NORMAL)
    due_at = serializers.DateTimeField(required=False, allow_null=True, default=None)
    assignee = OrgUserField(required=False, allow_null=True, default=None)
    department = OrgDepartmentField(required=False, allow_null=True, default=None)
    resource_type = serializers.CharField(max_length=100, required=False, allow_blank=True, default="")
    resource_id = serializers.CharField(max_length=64, required=False, allow_blank=True, default="")


class TaskUpdateSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    priority = serializers.ChoiceField(choices=Task.Priority.choices, required=False)
    due_at = serializers.DateTimeField(required=False, allow_null=True)
    department = OrgDepartmentField(required=False, allow_null=True)
    version = serializers.IntegerField()


class AssignSerializer(serializers.Serializer):
    assignee = OrgUserField(allow_null=True)
    version = serializers.IntegerField()


class TransitionSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=Task.Status.choices)
    version = serializers.IntegerField()


class TaskViewSet(DocumentViewSet):
    authz_resource = services.TASK
    authz_actions = {"assign": "assign", "transition": "update"}
    queryset = Task.objects.select_related("assignee").order_by("-created_at")
    serializer_class = TaskSerializer
    filterset_fields = ["status", "priority", "assignee", "department", "resource_type", "resource_id"]
    search_fields = ["title"]

    @extend_schema(request=TaskCreateSerializer, responses={201: TaskSerializer})
    def create(self, request):
        v = self.validated(TaskCreateSerializer)
        return self.respond(services.create_task(self.actor, **v), created=True)

    @extend_schema(
        request=TaskUpdateSerializer,
        responses=TaskSerializer,
        description="Edit an active task; send `version` for optimistic locking.",
    )
    def partial_update(self, request, pk=None):
        task = self.get_object()
        v = dict(self.validated(TaskUpdateSerializer))
        version = v.pop("version")
        return self.respond(services.update_task(self.actor, task, v, version))

    @extend_schema(request=AssignSerializer, responses=TaskSerializer)
    @action(detail=True, methods=["post"])
    def assign(self, request, pk=None):
        task = self.get_object()
        v = self.validated(AssignSerializer)
        return self.respond(services.assign_task(self.actor, task, v["assignee"], v["version"]))

    @extend_schema(request=TransitionSerializer, responses=TaskSerializer)
    @action(detail=True, methods=["post"])
    def transition(self, request, pk=None):
        task = self.get_object()
        v = self.validated(TransitionSerializer)
        return self.respond(services.transition_task(self.actor, task, v["status"], v["version"]))


class MyTaskViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, ERPGenericViewSet):
    """Tasks assigned to the caller in the active company (self-service).

    Status changes still go through the PDP (`collaboration.task.update`, normally granted to
    assignees by the `allow_own_tasks` policy).
    """

    authz_authenticated_only = True
    serializer_class = TaskSerializer
    filterset_fields = ["status", "priority"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Task.objects.none()
        return services.my_tasks(self.actor).select_related("assignee").order_by("due_at", "-created_at")

    @extend_schema(request=TransitionSerializer, responses=TaskSerializer)
    @action(detail=True, methods=["post"])
    def transition(self, request, pk=None):
        task = self.get_object()
        data = TransitionSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        task = services.transition_task(self.actor, task, data.validated_data["status"], data.validated_data["version"])
        return Response(TaskSerializer(self.get_queryset().get(pk=task.pk)).data)


# --- Comments --------------------------------------------------------------------------------------


class CommentSerializer(serializers.ModelSerializer):
    author_name = serializers.CharField(source="author.full_name", read_only=True)
    body = serializers.SerializerMethodField()
    mentions = serializers.SerializerMethodField()

    class Meta:
        model = Comment
        fields = [
            "id",
            "version",
            "resource_type",
            "resource_id",
            "author",
            "author_name",
            "body",
            "mentions",
            "edited_at",
            "is_removed",
            "removed_at",
            "created_at",
        ]
        read_only_fields = fields

    def get_body(self, obj) -> str:
        return "" if obj.is_removed else obj.body

    def get_mentions(self, obj) -> list[str]:
        return [str(m.user_id) for m in obj.mentions.all()]


class RecordRefSerializer(serializers.Serializer):
    resource_type = serializers.CharField(max_length=100)
    resource_id = serializers.CharField(max_length=64)


class CommentCreateSerializer(RecordRefSerializer):
    body = serializers.CharField(max_length=services.MAX_COMMENT_LENGTH, trim_whitespace=True)


class CommentEditSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=services.MAX_COMMENT_LENGTH, trim_whitespace=True)
    version = serializers.IntegerField()


RECORD_PARAMS = [
    OpenApiParameter("resource_type", OpenApiTypes.STR, required=True, description="e.g. procurement.purchase_order"),
    OpenApiParameter("resource_id", OpenApiTypes.STR, required=True),
]


class CommentViewSet(ERPGenericViewSet):
    """Comments on any business record; access is delegated to `<resource_type>.read` on the record."""

    authz_resource = services.COMMENT
    authz_actions = {"remove": "update"}
    queryset = Comment.objects.select_related("author").prefetch_related("mentions")
    serializer_class = CommentSerializer
    filter_backends: list = []

    def get_object(self):
        comment = get_object_or_404(self.get_queryset(), pk=self.kwargs["pk"])
        services.require_comment_access(self.actor, comment)  # 404 when the record is out of reach
        self.check_object_permissions(self.request, comment)
        return comment

    @extend_schema(parameters=RECORD_PARAMS, responses=CommentSerializer(many=True))
    def list(self, request):
        ref = RecordRefSerializer(data=request.query_params)
        ref.is_valid(raise_exception=True)
        queryset = (
            services.comments_for(self.actor, ref.validated_data["resource_type"], ref.validated_data["resource_id"])
            .prefetch_related("mentions")
            .order_by("created_at")
        )
        page = self.paginate_queryset(queryset)
        return self.get_paginated_response(CommentSerializer(page, many=True).data)

    @extend_schema(responses=CommentSerializer)
    def retrieve(self, request, pk=None):
        return Response(CommentSerializer(self.get_object()).data)

    @extend_schema(request=CommentCreateSerializer, responses={201: CommentSerializer})
    def create(self, request):
        data = CommentCreateSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        comment = services.add_comment(self.actor, **data.validated_data)
        return Response(CommentSerializer(self.get_queryset().get(pk=comment.pk)).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        request=CommentEditSerializer,
        responses=CommentSerializer,
        description="Authors may edit within 15 minutes; earlier bodies are kept as revisions.",
    )
    def partial_update(self, request, pk=None):
        comment = self.get_object()
        data = CommentEditSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        comment = services.edit_comment(
            self.actor, comment, data.validated_data["body"], data.validated_data["version"]
        )
        return Response(CommentSerializer(self.get_queryset().get(pk=comment.pk)).data)

    @extend_schema(request=VersionBody, responses=CommentSerializer, description="Soft-remove your own comment.")
    @action(detail=True, methods=["post"])
    def remove(self, request, pk=None):
        comment = self.get_object()
        data = VersionBody(data=request.data)
        data.is_valid(raise_exception=True)
        comment = services.remove_comment(self.actor, comment, data.validated_data.get("version"))
        return Response(CommentSerializer(self.get_queryset().get(pk=comment.pk)).data)


class ActivityEntrySerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=[("comment", "comment"), ("audit", "audit")])
    id = serializers.UUIDField()
    occurred_at = serializers.DateTimeField()
    actor_id = serializers.UUIDField(allow_null=True)
    actor_label = serializers.CharField()
    action = serializers.CharField()
    summary = serializers.CharField(allow_blank=True)
    edited_at = serializers.DateTimeField(allow_null=True)


class ActivityViewSet(ERPGenericViewSet):
    """Read-only timeline of a record: comments merged with its audit events (newest first)."""

    authz_resource = services.COMMENT
    queryset = Comment.objects.none()
    serializer_class = ActivityEntrySerializer
    filter_backends: list = []
    pagination_class = None

    @extend_schema(
        parameters=[*RECORD_PARAMS, OpenApiParameter("limit", OpenApiTypes.INT, description="Max entries (≤ 500)")],
        responses=ActivityEntrySerializer(many=True),
    )
    def list(self, request):
        ref = RecordRefSerializer(data=request.query_params)
        ref.is_valid(raise_exception=True)
        limit = serializers.IntegerField(min_value=1, max_value=500).run_validation(
            request.query_params.get("limit", 200)
        )
        entries = services.activity(
            actor_for(request), ref.validated_data["resource_type"], ref.validated_data["resource_id"], limit
        )
        return Response(ActivityEntrySerializer(entries, many=True).data)


# --- Escalation rules ------------------------------------------------------------------------------


class EscalationRuleSerializer(serializers.ModelSerializer):
    company = ScopedPrimaryKeyRelatedField(
        queryset=Company.objects.all(), read_action="collaboration.escalation_rule.read"
    )
    role = OrgRoleField(required=False, allow_null=True)

    class Meta:
        model = EscalationRule
        fields = [
            "id",
            "version",
            "company",
            "code",
            "name",
            "overdue_hours",
            "target",
            "role",
            "priority",
            "is_active",
        ]
        read_only_fields = ["id", "version"]
        validators: list = []


@master_schema
class EscalationRuleViewSet(MasterDataViewSet):
    authz_resource = "collaboration.escalation_rule"
    queryset = EscalationRule.objects.all()
    serializer_class = EscalationRuleSerializer
    editable_fields = ("name", "overdue_hours", "target", "role", "priority", "is_active")
    filterset_fields = ["target", "is_active"]


router = SimpleRouter()
router.register("collaboration/tasks", TaskViewSet, basename="collab-task")
router.register("collaboration/my-tasks", MyTaskViewSet, basename="collab-my-task")
router.register("collaboration/comments", CommentViewSet, basename="collab-comment")
router.register("collaboration/activity", ActivityViewSet, basename="collab-activity")
router.register("collaboration/escalation-rules", EscalationRuleViewSet, basename="collab-escalation-rule")
urlpatterns = router.urls
