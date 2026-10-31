from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("masterdata/uoms", views.UomViewSet, basename="uom")
router.register("masterdata/uom-conversions", views.UomConversionViewSet, basename="uom-conversion")
router.register("masterdata/item-categories", views.ItemCategoryViewSet, basename="item-category")
router.register("masterdata/hsn-codes", views.HsnCodeViewSet, basename="hsn-code")
router.register("masterdata/items", views.ItemViewSet, basename="item")
router.register("masterdata/item-policies", views.ItemWarehousePolicyViewSet, basename="item-policy")
urlpatterns = router.urls
