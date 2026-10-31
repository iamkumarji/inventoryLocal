from django.apps import AppConfig


class AuthorizationConfig(AppConfig):
    name = "apps.authorization"
    label = "authorization"
    verbose_name = "Authorization"

    def ready(self) -> None:
        from apps.identity.services import register_session_policy_provider

        from . import signals, tenancy  # noqa: F401
        from .snapshot import get_snapshot

        tenancy.install()  # references in API input resolve only within the caller's organization

        def session_policy(user):
            snapshot = get_snapshot(user.pk)
            return {"mfa_required": snapshot.mfa_required, "max_session_minutes": snapshot.max_session_minutes}

        register_session_policy_provider(session_policy)
