from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("approvals/requests", views.ApprovalRequestViewSet, basename="approval-request")
router.register("approvals/matrices", views.ApprovalMatrixViewSet, basename="approval-matrix")
router.register("approvals/delegations", views.DelegationViewSet, basename="approval-delegation")

urlpatterns = [
    path("approvals/inbox/", views.InboxView.as_view(), name="approval-inbox"),
    path("approvals/inbox/count/", views.InboxCountView.as_view(), name="approval-inbox-count"),
    path("approvals/document-types/", views.DocumentTypesView.as_view(), name="approval-document-types"),
    *router.urls,
]
