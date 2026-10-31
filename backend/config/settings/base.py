"""Base settings shared by every environment.

Environment-specific modules (dev, test, prod) import from here and override.
All secrets and deployment-specific values come from environment variables.
"""

import os
from pathlib import Path
from urllib.parse import unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent.parent.parent


def env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value not in (None, "") else default


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


def database_from_url(url: str) -> dict:
    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ValueError("Only PostgreSQL is supported")
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(parsed.path.lstrip("/")),
        "USER": unquote(parsed.username or ""),
        "PASSWORD": unquote(parsed.password or ""),
        "HOST": parsed.hostname or "",
        "PORT": str(parsed.port or ""),
        "CONN_MAX_AGE": env_int("DB_CONN_MAX_AGE", 60),
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": {"application_name": "otabu-erp"},
    }


SECRET_KEY = env("DJANGO_SECRET_KEY", "")
DEBUG = False
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.postgres",
    "rest_framework",
    "django_filters",
    "drf_spectacular",
    "channels",
    "django_prometheus",
    # Foundation modules
    "apps.core",
    "apps.organization",
    "apps.identity",
    "apps.authorization",
    "apps.audit",
    "apps.notifications",
    "apps.approvals",
    # Business modules
    "apps.masterdata",
    "apps.partners",
    "apps.finance",
    "apps.inventory",
    "apps.quality",
    "apps.procurement",
    "apps.manufacturing",
    "apps.sales",
    "apps.logistics",
    "apps.assets",
    "apps.hr",
    "apps.expenses",
    "apps.collaboration",
    "apps.documents",
    "apps.analytics",
    "apps.ops",
    "apps.integrations",
    "apps.platform",
]

MIDDLEWARE = [
    "django_prometheus.middleware.PrometheusBeforeMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "apps.core.middleware.RequestContextMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django_prometheus.middleware.PrometheusAfterMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    }
]

DATABASES = {"default": database_from_url(env("DATABASE_URL", "postgres:///otabu_erp"))}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

AUTH_USER_MODEL = "identity.User"
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
        "OPTIONS": {"user_attributes": ("email", "full_name")},
    },
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Kolkata"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

REDIS_URL = env("REDIS_URL", "redis://localhost:6379/0")
# Cache and channel keys are namespaced by database, so installations (or test stacks) that share a
# Redis can never read each other's cached flags, permission snapshots or sockets.
_KEY_NAMESPACE = env("ERP_CACHE_PREFIX", "") or f"erp:{DATABASES['default'].get('NAME', 'default')}"
CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": REDIS_URL,
        "OPTIONS": {"CLIENT_CLASS": "django_redis.client.DefaultClient"},
        "KEY_PREFIX": _KEY_NAMESPACE,
    }
}

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [REDIS_URL], "prefix": f"asgi:{_KEY_NAMESPACE}"},
    }
}

# --- Django REST Framework -------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["apps.identity.authentication.SessionTokenAuthentication"],
    # Default deny: a view is reachable only if it declares how it is authorized.
    "DEFAULT_PERMISSION_CLASSES": ["apps.authorization.drf_permissions.ERPPermission"],
    "DEFAULT_RENDERER_CLASSES": ["apps.core.renderers.ERPJSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_PAGINATION_CLASS": "apps.core.pagination.StandardPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "EXCEPTION_HANDLER": "apps.core.exceptions.api_exception_handler",
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
        "rest_framework.throttling.ScopedRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": env("THROTTLE_ANON", "60/min"),
        "user": env("THROTTLE_USER", "1200/min"),
        "auth": env("THROTTLE_AUTH", "10/min"),
    },
    "COERCE_DECIMAL_TO_STRING": True,
    "UNAUTHENTICATED_USER": "django.contrib.auth.models.AnonymousUser",
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "OtabuPro ERP API",
    "DESCRIPTION": "Enterprise manufacturing ERP. See docs/API_SPECIFICATION.md for conventions.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "SCHEMA_PATH_PREFIX": r"/api/v1",
    "COMPONENT_SPLIT_REQUEST": True,
    "SERVE_PERMISSIONS": ["apps.authorization.drf_permissions.SchemaAccess"],
    "SERVE_AUTHENTICATION": ["apps.identity.authentication.SessionTokenAuthentication"],
    "ENUM_NAME_OVERRIDES": {
        "ApprovalRequestStatusEnum": "apps.approvals.models.ApprovalRequest.Status",
        "ApprovalStepStatusEnum": "apps.approvals.models.ApprovalStep.Status",
        "FiscalYearStatusEnum": "apps.organization.models.FiscalYear.Status",
        "FiscalPeriodStatusEnum": "apps.organization.models.FiscalPeriod.Status",
        "OutboxEventStatusEnum": "apps.core.models.OutboxEvent.Status",
        "TaskStatusEnum": "apps.collaboration.models.Task.Status",
    },
}

# --- Celery ----------------------------------------------------------------
CELERY_BROKER_URL = env("CELERY_BROKER_URL", REDIS_URL)
CELERY_RESULT_BACKEND = env("CELERY_RESULT_BACKEND", REDIS_URL)
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_ACKS_LATE = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_DEFAULT_QUEUE = "default"
CELERY_TASK_ROUTES = {
    "apps.core.tasks.relay_outbox": {"queue": "outbox"},
    "apps.audit.tasks.*": {"queue": "scheduled"},
    "apps.approvals.tasks.*": {"queue": "scheduled"},
    "apps.notifications.tasks.*": {"queue": "notifications"},
    "apps.assets.tasks.*": {"queue": "scheduled"},
    "apps.collaboration.tasks.*": {"queue": "scheduled"},
    "apps.analytics.tasks.generate_report": {"queue": "reports"},
    "apps.analytics.tasks.purge_expired_reports": {"queue": "scheduled"},
    "apps.integrations.tasks.*": {"queue": "integrations"},
}
CELERY_BEAT_SCHEDULE = {
    "outbox-relay": {"task": "apps.core.tasks.relay_outbox", "schedule": 5.0},
    "audit-seal": {"task": "apps.audit.tasks.seal_audit_chain", "schedule": 60.0},
    "purge-expired": {"task": "apps.core.tasks.purge_expired_records", "schedule": 3600.0},
    "approval-escalation": {"task": "apps.approvals.tasks.escalate_overdue_approvals", "schedule": 300.0},
    "assets-preventive-maintenance": {
        "task": "apps.assets.tasks.generate_preventive_work_orders",
        "schedule": 86400.0,
    },
    "task-escalation": {"task": "apps.collaboration.tasks.escalate_overdue_tasks", "schedule": 300.0},
    "webhook-delivery": {"task": "apps.integrations.tasks.deliver_webhooks", "schedule": 30.0},
    "analytics-purge-reports": {"task": "apps.analytics.tasks.purge_expired_reports", "schedule": 3600.0},
}

# --- Document storage ----------------------------------------------------------
# MinIO/S3 when DOCUMENTS_S3_BUCKET is set; otherwise local files under var/documents (development).
if env("DOCUMENTS_S3_BUCKET", ""):
    DOCUMENTS_STORAGE = {
        "BACKEND": "apps.documents.storage.S3Storage",
        "OPTIONS": {
            "bucket": env("DOCUMENTS_S3_BUCKET"),
            "endpoint_url": env("DOCUMENTS_S3_ENDPOINT", "") or None,
            "region": env("DOCUMENTS_S3_REGION", "") or None,
            "access_key": env("DOCUMENTS_S3_ACCESS_KEY", "") or None,
            "secret_key": env("DOCUMENTS_S3_SECRET_KEY", "") or None,
            "prefix": env("DOCUMENTS_S3_PREFIX", ""),
            "public_endpoint_url": env("DOCUMENTS_S3_PUBLIC_ENDPOINT", "") or None,
        },
    }
else:
    DOCUMENTS_STORAGE = {"BACKEND": "apps.documents.storage.LocalFileStorage"}
DOCUMENTS_MAX_UPLOAD_BYTES = env_int("DOCUMENTS_MAX_UPLOAD_BYTES", 25 * 1024 * 1024)
DOCUMENTS_URL_TTL_SECONDS = 300

# --- Field encryption --------------------------------------------------------
# Comma-separated Fernet keys; the first encrypts, all decrypt (key rotation).
FIELD_ENCRYPTION_KEYS = env_list("FIELD_ENCRYPTION_KEYS")

# --- ERP platform configuration ------------------------------------------------
# Security defaults. Business rules (approval limits, roles, taxes, warehouse
# permissions) are data, never settings.
ERP = {
    "SESSION_IDLE_MINUTES": env_int("ERP_SESSION_IDLE_MINUTES", 30),
    "SESSION_ABSOLUTE_HOURS": env_int("ERP_SESSION_ABSOLUTE_HOURS", 12),
    "MOBILE_SESSION_IDLE_MINUTES": env_int("ERP_MOBILE_SESSION_IDLE_MINUTES", 8 * 60),
    "MOBILE_SESSION_ABSOLUTE_HOURS": env_int("ERP_MOBILE_SESSION_ABSOLUTE_HOURS", 7 * 24),
    "SESSION_TOUCH_SECONDS": 60,
    "STEP_UP_MINUTES": env_int("ERP_STEP_UP_MINUTES", 15),
    # Days a user who must enrol two-step sign-in may postpone it ("Skip for now"). 0 = no skipping.
    "MFA_ENROLLMENT_GRACE_DAYS": env_int("ERP_MFA_ENROLLMENT_GRACE_DAYS", 0),
    "LOCKOUT_THRESHOLD": env_int("ERP_LOCKOUT_THRESHOLD", 5),
    "LOCKOUT_MINUTES": env_int("ERP_LOCKOUT_MINUTES", 15),
    "PASSWORD_HISTORY": env_int("ERP_PASSWORD_HISTORY", 5),
    "MFA_CHALLENGE_MINUTES": 5,
    "MFA_CHALLENGE_MAX_ATTEMPTS": 5,
    "TOTP_ISSUER": env("ERP_TOTP_ISSUER", "OtabuPro ERP"),
    "RECOVERY_CODE_COUNT": 10,
    "IDEMPOTENCY_TTL_HOURS": env_int("ERP_IDEMPOTENCY_TTL_HOURS", 24),
    "OUTBOX_MAX_ATTEMPTS": env_int("ERP_OUTBOX_MAX_ATTEMPTS", 10),
    "OUTBOX_BATCH_SIZE": 100,
    "OUTBOX_NUDGE_ON_COMMIT": env_bool("ERP_OUTBOX_NUDGE_ON_COMMIT", True),
    "INTERNAL_NETWORKS": env_list(
        "ERP_INTERNAL_NETWORKS", "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128"
    ),
    "TRUSTED_PROXY_COUNT": env_int("ERP_TRUSTED_PROXY_COUNT", 0),
    "SESSION_COOKIE_NAME": "erp_session",
    "CSRF_COOKIE_NAME": "erp_csrf",
    "CSRF_HEADER_NAME": "HTTP_X_CSRF_TOKEN",
    "COOKIE_SECURE": env_bool("ERP_COOKIE_SECURE", True),
    "COOKIE_DOMAIN": env("ERP_COOKIE_DOMAIN") or None,
    # Modules that are part of the platform and never behind a feature flag.
    "ALWAYS_ON_MODULES": ["core", "organization", "identity", "authorization", "audit", "approvals", "notifications"],
    "AUTHZ_CACHE_SECONDS": 300,
    "PUBLIC_SCHEMA": env_bool("ERP_PUBLIC_SCHEMA", False),
    "WEB_BASE_URL": env("ERP_WEB_BASE_URL", "http://localhost:3000"),
    # Webhooks: https only unless explicitly allowed; private destinations only inside these CIDRs.
    "WEBHOOK_ALLOW_HTTP": env_bool("ERP_WEBHOOK_ALLOW_HTTP", False),
    "WEBHOOK_ALLOWED_PRIVATE_NETWORKS": env_list("ERP_WEBHOOK_ALLOWED_PRIVATE_NETWORKS"),
    # Development-only demo document types and seed data (ignored unless DEBUG).
    "DEMO_DATA": env_bool("ERP_DEMO_DATA", False),
}

EMAIL_BACKEND = env("EMAIL_BACKEND", "django.core.mail.backends.smtp.EmailBackend")
EMAIL_HOST = env("EMAIL_HOST", "localhost")
EMAIL_PORT = env_int("EMAIL_PORT", 25)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", False)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", "erp-noreply@localhost")

SENTRY_DSN = env("SENTRY_DSN")

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"request_context": {"()": "apps.core.logging.RequestContextFilter"}},
    "formatters": {"json": {"()": "apps.core.logging.JSONFormatter"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "json", "filters": ["request_context"]}},
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", "INFO")},
    "loggers": {
        "django.db.backends": {"level": "WARNING"},
        "erp.security": {"level": "INFO"},
    },
}
