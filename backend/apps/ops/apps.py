from django.apps import AppConfig


class OpsConfig(AppConfig):
    """Operational commands that span modules (integrity checks, key rotation). No models."""

    name = "apps.ops"
    label = "ops"
    verbose_name = "Operations"
