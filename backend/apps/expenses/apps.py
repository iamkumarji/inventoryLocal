from django.apps import AppConfig


class ExpensesConfig(AppConfig):
    name = "apps.expenses"
    label = "expenses"
    verbose_name = "Expenses"

    def ready(self) -> None:
        from . import services  # noqa: F401 - registers approvable document types
