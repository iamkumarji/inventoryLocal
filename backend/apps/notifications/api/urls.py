from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("notifications", views.NotificationViewSet, basename="notification")
urlpatterns = [
    path("notifications/preferences/", views.NotificationPreferencesView.as_view(), name="notification-preferences"),
    *router.urls,
]
