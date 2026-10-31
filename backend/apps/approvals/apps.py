from django.apps import AppConfig


class ApprovalsConfig(AppConfig):
    name = "apps.approvals"
    label = "approvals"
    verbose_name = "Approvals"

    def ready(self) -> None:
        from . import demo, handlers  # noqa: F401 - registers outbox handlers

        demo.register()
