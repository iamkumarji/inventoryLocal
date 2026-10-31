"""Production settings. Every secret must come from the environment."""

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F401,F403
from .base import ERP, FIELD_ENCRYPTION_KEYS, SECRET_KEY, SENTRY_DSN, env, env_int, env_list

if len(SECRET_KEY) < 50:
    raise ImproperlyConfigured("DJANGO_SECRET_KEY must be set to a random value of 50+ characters")
if not FIELD_ENCRYPTION_KEYS:
    raise ImproperlyConfigured("FIELD_ENCRYPTION_KEYS must be set")

DEBUG = False
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = False  # Traefik terminates TLS and redirects
SECURE_HSTS_SECONDS = env_int("SECURE_HSTS_SECONDS", 31536000)
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS")
ERP["COOKIE_SECURE"] = True
ERP["TRUSTED_PROXY_COUNT"] = env_int("ERP_TRUSTED_PROXY_COUNT", 1)

if SENTRY_DSN:
    import sentry_sdk

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=env("SENTRY_ENVIRONMENT", "production"),
        traces_sample_rate=float(env("SENTRY_TRACES_SAMPLE_RATE", "0.05")),
        send_default_pii=False,
    )
