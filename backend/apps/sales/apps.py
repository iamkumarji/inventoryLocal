from django.apps import AppConfig


class SalesConfig(AppConfig):
    name = "apps.sales"
    label = "sales"
    verbose_name = "Sales"

    def ready(self) -> None:
        from . import services  # noqa: F401 - registers approvable document types
