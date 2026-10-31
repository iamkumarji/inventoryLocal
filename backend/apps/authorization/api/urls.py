from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("authorization/permissions", views.PermissionViewSet, basename="permission")
router.register("authorization/roles", views.RoleViewSet, basename="role")
router.register("authorization/role-assignments", views.RoleAssignmentViewSet, basename="role-assignment")
router.register("authorization/policies", views.PolicyViewSet, basename="policy")
router.register("authorization/sod-rules", views.SodRuleViewSet, basename="sod-rule")
router.register("authorization/approval-limits", views.ApprovalLimitViewSet, basename="approval-limit")

urlpatterns = [path("authorization/check/", views.CheckView.as_view(), name="authz-check"), *router.urls]
