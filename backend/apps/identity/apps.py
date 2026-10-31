from django.apps import AppConfig


class IdentityConfig(AppConfig):
    name = "apps.identity"
    label = "identity"
    verbose_name = "Identity"

    def ready(self) -> None:
        from . import schema  # noqa: F401 - registers the OpenAPI auth extension
