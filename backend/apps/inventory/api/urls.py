from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("inventory/locations", views.LocationViewSet, basename="location")
router.register("inventory/stock", views.StockViewSet, basename="stock")
router.register("inventory/ledger", views.LedgerViewSet, basename="stock-ledger")
router.register("inventory/batches", views.BatchViewSet, basename="batch")
router.register("inventory/serials", views.SerialViewSet, basename="serial")
router.register("inventory/adjustments", views.AdjustmentViewSet, basename="stock-adjustment")
router.register("inventory/transfers", views.TransferViewSet, basename="stock-transfer")
router.register("inventory/counts", views.CountViewSet, basename="stock-count")

urlpatterns = [
    path("inventory/availability/", views.AvailabilityView.as_view(), name="availability"),
    path("inventory/ageing/", views.AgeingView.as_view(), name="ageing"),
    path("inventory/scan/", views.ScanView.as_view(), name="scan"),
    *router.urls,
]
