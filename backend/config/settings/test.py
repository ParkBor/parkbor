from .base import *  # noqa: F403
from .base import env

# Allow text stand-ins for geometry fields when GDAL is missing (never set in base/prod).
GEO_STUB = True
SECRET_KEY = "test-only-not-a-secret"
DEBUG = False
ALLOWED_HOSTS = ["testserver", "localhost"]
# DB selection for tests:
#  - TEST_DATABASE_URL set (postgis://...), or GDAL available -> real PostGIS (CI).
#  - no GDAL (plain dev box) -> in-memory SQLite; apps.core.geo swaps geometry fields for
#    text stand-ins, so only tests marked `postgis` (spatial behaviour) are skipped.
from apps.core.gis_detect import detect_gis  # noqa: E402

_test_db_url = env("TEST_DATABASE_URL", default="")
if _test_db_url:
    DATABASES = {"default": env.db_url_config(_test_db_url)}
elif detect_gis():
    DATABASES = {"default": env.db_url_config("postgis://habi:habi@localhost:5432/habi")}
else:
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
if "postgres" in DATABASES["default"]["ENGINE"] or "postgis" in DATABASES["default"]["ENGINE"]:
    # A stuck lock or runaway query must fail the test, not hang CI.
    DATABASES["default"]["OPTIONS"] = {
        **DATABASES["default"].get("OPTIONS", {}),
        "options": "-c lock_timeout=20s -c statement_timeout=60s",
    }
# 50 users queue on one lot lock in the parallel tests: do not let the per-request 5 s ceiling
# turn that into false 503s.
BOOKING_LOCK_TIMEOUT_SECONDS = 30
QR_SIGNING_KEY = "test-only-qr-signing-key-0123456789abcdef-0123456789abcdef"
REDIS_URL = "redis://localhost:6379/0"
STATE_REDIS_URL = "redis://localhost:6379/3"
CELERY_BROKER_URL = "memory://"
CELERY_RESULT_BACKEND = "cache+memory://"
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
SIMPLE_JWT = {  # noqa: F405
    **SIMPLE_JWT,  # noqa: F405
    "SIGNING_KEY": "test-only-jwt-signing-key-0123456789abcdef",
}
TELEGRAM_BOT_TOKEN = "123456:TEST-TOKEN"
TELEGRAM_BOT_USERNAME = "ParkBorTestBot"
TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret"
# Fake provider credentials: no real payment is ever possible from tests.
PAYMENTS_SANDBOX = True
PAYME_MERCHANT_ID = "587f72c72cac0d162c722ae2"
PAYME_KEY = "test-payme-key-0123456789-abcdefghij"
CLICK_SERVICE_ID = "36"
CLICK_MERCHANT_ID = "46"
CLICK_MERCHANT_USER_ID = "4"
CLICK_SECRET_KEY = "test-click-secret"
PAYMENTS_RETURN_URL = "https://parkbor.test/payment-return"
# Parallel postgis tests queue many callbacks on one lot lock (like BOOKING_LOCK_TIMEOUT above).
PAYMENTS_LOCK_TIMEOUT_SECONDS = 30
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
HABI_PUBLIC_URL = "https://parkbor.test"
EXPO_ACCESS_TOKEN = ""
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
