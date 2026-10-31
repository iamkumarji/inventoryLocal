from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("partners", views.PartnerViewSet, basename="partner")
urlpatterns = router.urls
