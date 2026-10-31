"""Test settings: real PostgreSQL (constraints and triggers matter), in-memory cache."""

import tempfile

from .base import *  # noqa: F401,F403
from .base import ERP, REST_FRAMEWORK, database_from_url, env

SECRET_KEY = "test-secret-key-not-for-production-0123456789abcdef"
DATABASES = {"default": database_from_url(env("DATABASE_URL", "postgres:///otabu_erp"))}
DATABASES["default"]["CONN_MAX_AGE"] = 0
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]  # speed only
FIELD_ENCRYPTION_KEYS = ["sBrd6pqcSeZS1fYb3B2tQe5bCeyY0Uo3ABmUVmTjl1E="]
CELERY_TASK_ALWAYS_EAGER = True
ERP["COOKIE_SECURE"] = False
ERP["OUTBOX_NUDGE_ON_COMMIT"] = False
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"] = {"anon": "10000/min", "user": "10000/min", "auth": "10000/min"}
LOGGING = {"version": 1, "disable_existing_loggers": False, "root": {"level": "WARNING"}}
DOCUMENTS_STORAGE = {
    "BACKEND": "apps.documents.storage.LocalFileStorage",
    "OPTIONS": {"root": tempfile.mkdtemp(prefix="otabu-documents-")},
}
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
