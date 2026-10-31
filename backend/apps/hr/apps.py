from django.apps import AppConfig


class HrConfig(AppConfig):
    name = "apps.hr"
    label = "hr"
    verbose_name = "HR and payroll"

    def ready(self) -> None:
        from . import services  # noqa: F401 - registers approvable document types
