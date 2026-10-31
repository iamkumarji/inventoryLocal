from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("procurement/requisitions", views.RequisitionViewSet, basename="purchase-requisition")
router.register("procurement/rfqs", views.RFQViewSet, basename="rfq")
router.register("procurement/orders", views.OrderViewSet, basename="purchase-order")
router.register("procurement/receipts", views.ReceiptViewSet, basename="goods-receipt")
router.register("procurement/returns", views.ReturnViewSet, basename="purchase-return")
router.register("procurement/mrp", views.MrpViewSet, basename="mrp")
urlpatterns = router.urls
