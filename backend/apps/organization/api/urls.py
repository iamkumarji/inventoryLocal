from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("organization/companies", views.CompanyViewSet, basename="company")
router.register("organization/branches", views.BranchViewSet, basename="branch")
router.register("organization/departments", views.DepartmentViewSet, basename="department")
router.register("organization/facilities", views.FacilityViewSet, basename="facility")
router.register("organization/warehouses", views.WarehouseViewSet, basename="warehouse")
router.register("organization/fiscal-years", views.FiscalYearViewSet, basename="fiscal-year")

urlpatterns = [
    path("organization/scope-tree/", views.ScopeTreeView.as_view(), name="scope-tree"),
    path("organization/security/", views.SecuritySettingsView.as_view(), name="security-settings"),
    *router.urls,
]
