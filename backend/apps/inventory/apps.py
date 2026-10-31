from django.apps import AppConfig


class InventoryConfig(AppConfig):
    name = "apps.inventory"
    label = "inventory"
    verbose_name = "Inventory and warehouse"

    def ready(self) -> None:
        from . import documents  # noqa: F401 - registers approval document types
