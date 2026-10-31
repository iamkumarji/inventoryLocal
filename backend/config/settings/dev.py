"""Local development settings. Never use in production."""

from .base import *  # noqa: F401,F403
from .base import ERP, env, env_bool

DEBUG = True
SECRET_KEY = env("DJANGO_SECRET_KEY", "dev-insecure-secret-key-change-me-0123456789abcdef")
ALLOWED_HOSTS = ["*"]
ERP["COOKIE_SECURE"] = False
ERP["PUBLIC_SCHEMA"] = True

# Development-only Fernet key (labelled; production must set FIELD_ENCRYPTION_KEYS).
FIELD_ENCRYPTION_KEYS = [env("FIELD_ENCRYPTION_KEYS", "sBrd6pqcSeZS1fYb3B2tQe5bCeyY0Uo3ABmUVmTjl1E=")]

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
ERP["DEMO_DATA"] = env_bool("ERP_DEMO_DATA", True)
