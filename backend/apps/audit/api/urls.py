from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("audit/events", views.AuditEventViewSet, basename="audit-event")
urlpatterns = router.urls
