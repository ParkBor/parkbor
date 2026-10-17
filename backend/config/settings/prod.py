from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import env

# Everything below is required from the environment: no defaults, startup fails if missing.
DEBUG = False
SECRET_KEY = env("SECRET_KEY")
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS")
DATABASES = {"default": env.db("DATABASE_URL")}
# Spatial queries (ST_DWithin, KNN) and the geography column need PostGIS: a plain postgres://
# or sqlite URL would only fail later, at the first nearby request. Fail at startup instead.
if DATABASES["default"]["ENGINE"] != "django.contrib.gis.db.backends.postgis":
    raise ImproperlyConfigured("DATABASE_URL must use the PostGIS scheme (postgis://...).")
# Global ceilings for every connection (web and Celery): a request never waits more than 10 s for
# a row lock nor runs a statement for more than 30 s. Booking writes set tighter per-transaction
# values themselves (BOOKING_LOCK_TIMEOUT_SECONDS; sweeps 5 s / 20 s), see bookings/services.py.
DATABASES["default"]["OPTIONS"] = {
    **DATABASES["default"].get("OPTIONS", {}),
    "options": "-c lock_timeout=10s -c statement_timeout=30s",
}
REDIS_URL = env("REDIS_URL")
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL

SECURE_SSL_REDIRECT = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
# No SESSION_COOKIE_SECURE / CSRF_COOKIE_SECURE: auth is JWT-only (no sessions, no cookies).
# JWT in the Authorization header is not auto-sent by browsers, so CSRF middleware adds nothing.
SILENCED_SYSTEM_CHECKS = ["security.W003"]

# Auth/Telegram secrets: mandatory, no defaults.
SIMPLE_JWT = {**SIMPLE_JWT, "SIGNING_KEY": env("JWT_SIGNING_KEY")}  # noqa: F405
QR_SIGNING_KEY = env("QR_SIGNING_KEY")  # separate from SECRET_KEY; rotate via ..._FALLBACKS
if len(QR_SIGNING_KEY) < 50:
    raise ImproperlyConfigured("QR_SIGNING_KEY must be at least 50 characters.")
TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN")
TELEGRAM_BOT_USERNAME = env("TELEGRAM_BOT_USERNAME")
TELEGRAM_WEBHOOK_SECRET = env("TELEGRAM_WEBHOOK_SECRET")
# Payment providers (Step 8a): every credential is mandatory, sandbox mode is refused.
PAYME_MERCHANT_ID = env("PAYME_MERCHANT_ID")
PAYME_KEY = env("PAYME_KEY")
CLICK_SERVICE_ID = env("CLICK_SERVICE_ID")
CLICK_MERCHANT_ID = env("CLICK_MERCHANT_ID")
CLICK_MERCHANT_USER_ID = env("CLICK_MERCHANT_USER_ID")
CLICK_SECRET_KEY = env("CLICK_SECRET_KEY")
from apps.payments.settings_checks import PAYME_PUBLISHED_IPS  # noqa: E402
from apps.payments.settings_checks import validate_production as _validate_payments  # noqa: E402

# Payme's addresses are published, so they are the production default (override to narrow it);
# Click's are not documented: set PAYMENTS_CLICK_IPS / PAYMENTS_PROVIDER_IPS when CLICK gives them.
PAYMENTS_PAYME_IPS = env.list("PAYMENTS_PAYME_IPS", default=PAYME_PUBLISHED_IPS)

_validate_payments(
    {
        name: globals()[name]  # noqa: F405
        for name in (
            "PAYME_MERCHANT_ID",
            "PAYME_KEY",
            "CLICK_SERVICE_ID",
            "CLICK_MERCHANT_ID",
            "CLICK_MERCHANT_USER_ID",
            "CLICK_SECRET_KEY",
            "PAYMENTS_SANDBOX",
            "PAYMENTS_PROVIDER_IPS",
            "PAYMENTS_PAYME_IPS",
            "PAYMENTS_CLICK_IPS",
            "PAYMENTS_RETURN_URL",
            "PAYME_CHECKOUT_URL",
        )
    }
)
CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": REDIS_URL}
}
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [REDIS_URL]},
    }
}
# Universal links in Telegram buttons: mandatory, https only (see apps.notifications.links).
from apps.notifications.links import validate_public_url  # noqa: E402

HABI_PUBLIC_URL = validate_public_url(env("HABI_PUBLIC_URL"))
# Nginx is the single trusted proxy in front of the app (see docs/ARCHITECTURE.md, section 17).
REST_FRAMEWORK = {**REST_FRAMEWORK, "NUM_PROXIES": env.int("NUM_PROXIES", default=1)}  # noqa: F405

# Argon2 first; the other hashers stay so that any existing hashes still verify.
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
# API docs are not exposed in production unless explicitly enabled.
SCHEMA_PUBLIC = env.bool("SCHEMA_PUBLIC", default=False)

# No browsable API / OPTIONS schema introspection in production: JSON only.
REST_FRAMEWORK = {  # noqa: F405
    **REST_FRAMEWORK,  # noqa: F405
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_METADATA_CLASS": None,
}

# Sentry is initialised only when SENTRY_DSN is set (scrubs bot tokens from events).
from config.sentry import init_sentry  # noqa: E402

init_sentry(env("SENTRY_DSN", default=""))
