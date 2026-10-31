from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("auth/sessions", views.OwnSessionsViewSet, basename="own-session")
router.register("identity/users", views.UserViewSet, basename="user")

urlpatterns = [
    path("auth/login/", views.LoginView.as_view(), name="auth-login"),
    path("auth/login/mfa/", views.MFALoginView.as_view(), name="auth-login-mfa"),
    path("auth/logout/", views.LogoutView.as_view(), name="auth-logout"),
    path("auth/me/", views.MeView.as_view(), name="auth-me"),
    path("identity/directory/", views.DirectoryView.as_view(), name="directory"),
    path("auth/step-up/", views.StepUpView.as_view(), name="auth-step-up"),
    path("auth/password/change/", views.PasswordChangeView.as_view(), name="auth-password-change"),
    path("auth/mfa/totp/setup/", views.TOTPSetupView.as_view(), name="auth-totp-setup"),
    path("auth/mfa/totp/confirm/", views.TOTPConfirmView.as_view(), name="auth-totp-confirm"),
    path("auth/mfa/recovery-codes/regenerate/", views.RecoveryCodesView.as_view(), name="auth-recovery-codes"),
    path("auth/mfa/disable/", views.DisableMFAView.as_view(), name="auth-mfa-disable"),
    *router.urls,
]
