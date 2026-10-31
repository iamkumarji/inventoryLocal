from django.apps import AppConfig


class PlatformConfig(AppConfig):
    """Hosting-platform administration: creating and suspending organizations (tenants). No models."""

    name = "apps.platform"
    label = "platform"
    verbose_name = "Platform"
