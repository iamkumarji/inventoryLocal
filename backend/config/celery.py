import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("otabu_erp")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
