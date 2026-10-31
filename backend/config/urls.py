from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularRedocView, SpectacularSwaggerView

from apps.core.api.views import health_live, health_ready

api_v1 = [
    path("", include("apps.core.api.urls")),
    path("", include("apps.identity.api.urls")),
    path("", include("apps.organization.api.urls")),
    path("", include("apps.authorization.api.urls")),
    path("", include("apps.audit.api.urls")),
    path("", include("apps.notifications.api.urls")),
    path("", include("apps.approvals.api.urls")),
    path("", include("apps.masterdata.api.urls")),
    path("", include("apps.partners.api.urls")),
    path("", include("apps.finance.api.urls")),
    path("", include("apps.inventory.api.urls")),
    path("", include("apps.quality.api")),
    path("", include("apps.procurement.api.urls")),
    path("", include("apps.manufacturing.api")),
    path("", include("apps.sales.api")),
    path("", include("apps.logistics.api")),
    path("", include("apps.assets.api")),
    path("", include("apps.hr.api")),
    path("", include("apps.expenses.api")),
    path("", include("apps.collaboration.api")),
    path("", include("apps.documents.api")),
    path("", include("apps.analytics.api")),
    path("", include("apps.integrations.api")),
    path("schema/", SpectacularAPIView.as_view(), name="schema"),
    path("docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
]

urlpatterns = [
    path("health/live", health_live),
    path("health/ready", health_ready),
    path("api/v1/", include(api_v1)),
    path("", include("django_prometheus.urls")),
]
