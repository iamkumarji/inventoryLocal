from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("admin/feature-flags", views.FeatureFlagViewSet, basename="feature-flag")
router.register("admin/outbox-events", views.OutboxEventViewSet, basename="outbox-event")

urlpatterns = [path("meta/feature-flags/", views.EffectiveFlagsView.as_view(), name="effective-flags"), *router.urls]
