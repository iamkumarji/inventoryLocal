from django.apps import AppConfig


class ProcurementConfig(AppConfig):
    name = "apps.procurement"
    label = "procurement"
    verbose_name = "Procurement"

    def ready(self) -> None:
        from . import services  # noqa: F401 - registers approvable document types
