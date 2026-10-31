from django.urls import path
from rest_framework.routers import SimpleRouter

from . import subledger_views as sv
from . import views

router = SimpleRouter()
router.register("finance/accounts", views.AccountViewSet, basename="gl-account")
router.register("finance/cost-centers", views.CostCenterViewSet, basename="cost-center")
router.register("finance/posting-rules", views.PostingRuleViewSet, basename="posting-rule")
router.register("finance/journal-entries", views.JournalEntryViewSet, basename="journal-entry")
router.register("finance/open-items", sv.OpenItemViewSet, basename="open-item")
router.register("finance/supplier-invoices", sv.SupplierInvoiceViewSet, basename="supplier-invoice")
router.register("finance/payments", sv.PaymentViewSet, basename="payment")
router.register("finance/bank-accounts", sv.BankAccountViewSet, basename="bank-account")
router.register("finance/budgets", sv.BudgetViewSet, basename="budget")

urlpatterns = [
    path("finance/reports/trial-balance/", views.TrialBalanceView.as_view(), name="trial-balance"),
    path("finance/reports/profit-and-loss/", views.ProfitAndLossView.as_view(), name="profit-and-loss"),
    path("finance/reports/balance-sheet/", views.BalanceSheetView.as_view(), name="balance-sheet"),
    path("finance/reports/ledger/<uuid:account_id>/", views.AccountLedgerView.as_view(), name="account-ledger"),
    path("finance/gst/gstr1/", sv.Gstr1View.as_view(), name="gstr1"),
    path("finance/gst/gstr3b/", sv.Gstr3bView.as_view(), name="gstr3b"),
    path("finance/close/checks/", sv.SubledgerCheckView.as_view(), name="close-checks"),
    path("finance/close/period/", sv.ClosePeriodView.as_view(), name="close-period"),
    path("finance/close/year/", sv.CloseYearView.as_view(), name="close-year"),
    path("finance/budgets/<uuid:budget_id>/vs-actual/", sv.BudgetVsActualView.as_view(), name="budget-vs-actual"),
    *router.urls,
]
