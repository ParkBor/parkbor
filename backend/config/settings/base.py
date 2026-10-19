from datetime import timedelta
from pathlib import Path

import environ
from django.core.exceptions import ImproperlyConfigured

from apps.routing import limits
from apps.routing.url_check import validate_osrm_url

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env()

# SECRET_KEY, DATABASES, REDIS_URL are intentionally NOT defined here: dev.py provides
# local defaults, prod.py requires them from the environment (no insecure fallbacks).
DEBUG = False
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])

# django.contrib.admin is intentionally absent: the admin panel is the React app.
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "django.contrib.gis",
    "django.contrib.postgres",
    "channels",
    "corsheaders",
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
    "django_filters",
    "drf_spectacular",
    "apps.core",
    "apps.accounts",
    "apps.telegram_bot",
    "apps.parking",
    "apps.vehicles",
    "apps.bookings",
    "apps.payments",
    "apps.audit",
    "apps.operators",
    "apps.reviews",
    "apps.adminpanel",
    "apps.realtime",
    "apps.notifications",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.adminpanel.middleware.AdminNoStoreMiddleware",
]
X_FRAME_OPTIONS = "DENY"

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

LANGUAGE_CODE = "uz"
TIME_ZONE = "Asia/Tashkent"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])

REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework_simplejwt.authentication.JWTAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "EXCEPTION_HANDLER": "apps.core.exception_handler.api_exception_handler",
    "DEFAULT_THROTTLE_RATES": {
        "telegram_auth": "10/min",
        "telegram_auth_status": "60/min",  # the app polls status while waiting for the bot
        "token_refresh": "30/min",
        "user": "60/min",  # authenticated endpoints (me, devices, logout), per user
        "nearby": "120/min",  # GET /parkings/nearby: the map re-queries while panning
        "routes": "60/min",  # GET /routes, per user
        "booking_create": "10/min",  # POST /bookings, per user (ARCHITECTURE 15)
        "booking_quote": "120/min",  # GET /parkings/{id}/price|availability: time pickers re-query
        "booking_mutate": "20/min",  # POST /bookings/{id}/cancel|extend, per user
        "booking_qr": "30/min",  # GET /bookings/{id}/qr, per user
        "operator_scan": "60/min",  # POST /operator/checkin|checkout, per user (shared budget)
        "operator_read": "120/min",  # GET /operator/parkings[/{id}/slots]: the map is polled
        "operator_write": "30/min",  # PATCH /operator/slots/{id}, POST /operator/walk-in
        "operator_assign": "20/min",  # owner/admin: invite / revoke operators, per user
        "operator_invite_accept": "10/hour",  # POST /me/operator-invites/accept, per user
        # Provider callbacks, per client IP: wide, because Payme/Click call from a few addresses
        # and retry; it only stops floods (the signature/auth check is the real gate).
        "payment_webhook": "600/min",
        "review_write": "10/hour",  # POST /parkings/{id}/reviews, per user
        "review_read": "120/min",  # GET /parkings/{id}/reviews, per user
        "admin_read": "120/min",  # GET /admin/* operations lists and stats, per user
        "admin_write": "30/min",  # admin mutations (users, cancel, resolve, moderation, settings)
        "ws_ticket": "30/min",  # POST /ws/ticket, per user (one per (re)connect)
    },
    # Number of trusted reverse proxies in front of the app (X-Forwarded-For). 0 = ignore the
    # header, so clients cannot spoof their IP and dodge throttling. prod.py raises it to 1.
    "NUM_PROXIES": 0,
}

AUTH_USER_MODEL = "accounts.User"

# OSRM routing server (Table API for /parkings/nearby, Route API for /routes). Internal URL;
# if it embeds credentials, they must never be logged (apps.routing.osrm_client does not).
OSRM_URL = validate_osrm_url(env("OSRM_URL", default="http://localhost:5000"))
# /routes service area "lat_min,lat_max,lng_min,lng_max" (Uzbekistan + border margin) and the
# longest accepted straight-line distance. Beyond ROUTING_FULL_OVERVIEW_MAX_KM OSRM is asked for
# a simplified geometry (smaller body, smaller cache entry).
ROUTING_BBOX = limits.parse_bbox(env("ROUTING_BBOX", default=limits.DEFAULT_BBOX))
ROUTING_MAX_STRAIGHT_KM = env.float(
    "ROUTING_MAX_STRAIGHT_KM", default=limits.DEFAULT_MAX_STRAIGHT_KM
)
ROUTING_FULL_OVERVIEW_MAX_KM = env.float(
    "ROUTING_FULL_OVERVIEW_MAX_KM", default=limits.DEFAULT_FULL_OVERVIEW_MAX_KM
)

# Only the back-up super admin has a password; keep it strong.
AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 12},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# Swagger/OpenAPI exposure; prod.py turns it off unless SCHEMA_PUBLIC=true.
SCHEMA_PUBLIC = True

# httpx/httpcore log full request URLs at INFO, and Bot API URLs contain the bot token.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "plain": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"},
        # Appends `extra` fields (audit_actor/before/after) as JSON.
        "with_extra": {
            "()": "apps.core.logging_utils.ExtraFieldsFormatter",
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "plain"},
        "audit": {"class": "logging.StreamHandler", "formatter": "with_extra"},
    },
    "root": {"handlers": ["console"], "level": "WARNING"},
    "loggers": {
        "habi.audit": {"handlers": ["audit"], "level": "INFO", "propagate": False},
        "httpx": {"level": "WARNING"},
        "httpcore": {"level": "WARNING"},
        "apps": {"level": "INFO"},  # login/bot audit lines
    },
}

# SIGNING_KEY is set per environment (JWT_SIGNING_KEY, separate from SECRET_KEY).
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=30),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": False,
    "ALGORITHM": "HS256",
}

# Telegram bot. Secrets come from the environment only; prod.py makes them mandatory.
TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN", default="")
TELEGRAM_BOT_USERNAME = env("TELEGRAM_BOT_USERNAME", default="")
TELEGRAM_WEBHOOK_SECRET = env("TELEGRAM_WEBHOOK_SECRET", default="")

SPECTACULAR_SETTINGS = {
    "TITLE": "ParkBor API",
    "DESCRIPTION": "Avtoturargoh bron qilish tizimi",
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "ENUM_NAME_OVERRIDES": {
        "SlotTypeEnum": "apps.parking.models.SlotType",
        "LotStatusEnum": "apps.parking.models.LotStatus",
        "SlotStatusEnum": "apps.parking.models.SlotStatus",
        "BookingStatusEnum": "apps.bookings.state.BookingStatus",
        "VehicleTypeEnum": "apps.vehicles.models.VehicleType",
        "PaymentProviderEnum": "apps.payments.models.PaymentProvider",
        "BookingKindEnum": "apps.bookings.state.BookingKind",
        "OverstayStatusEnum": "apps.bookings.state.OverstayStatus",
    },
}

# Broker/result URLs come from REDIS_URL, set per environment (dev/prod/test).
CELERY_TIMEZONE = TIME_ZONE
CELERY_TASK_TIME_LIMIT = 300
CELERY_TASK_SOFT_TIME_LIMIT = 270
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_RESULT_EXPIRES = 3600


# --- bookings (ARCHITECTURE 6.2, 10.3-10.7). All durations in minutes unless named otherwise. ---
# Every numeric value can be overridden from the environment; out-of-range values fail at startup.
def _booking_int(name: str, default: int, low: int, high: int) -> int:
    value = env.int(name, default=default)
    if not low <= value <= high:
        raise ImproperlyConfigured(f"{name}={value} is outside the allowed range {low}..{high}.")
    return value


BOOKING_MIN_DURATION_MINUTES = _booking_int("BOOKING_MIN_DURATION_MINUTES", 30, 5, 600)
BOOKING_MAX_DURATION_HOURS = _booking_int("BOOKING_MAX_DURATION_HOURS", 24, 1, 168)
BOOKING_MAX_ADVANCE_DAYS = _booking_int("BOOKING_MAX_ADVANCE_DAYS", 30, 1, 365)
BOOKING_START_TOLERANCE_MINUTES = _booking_int("BOOKING_START_TOLERANCE_MINUTES", 5, 0, 60)
BOOKING_HOLD_MINUTES = _booking_int("BOOKING_HOLD_MINUTES", 10, 1, 120)  # PENDING_PAYMENT hold
BOOKING_NO_SHOW_GRACE_MINUTES = _booking_int("BOOKING_NO_SHOW_GRACE_MINUTES", 20, 1, 240)
# A slot that is physically OCCUPIED/RESERVED right now cannot take a booking that starts within
# this window (walk-in cars have no end time).
BOOKING_IMMEDIATE_WINDOW_MINUTES = _booking_int("BOOKING_IMMEDIATE_WINDOW_MINUTES", 15, 0, 240)
BOOKING_MAX_PICK_ATTEMPTS = _booking_int("BOOKING_MAX_PICK_ATTEMPTS", 5, 1, 50)
BOOKING_TASK_BATCH_LIMIT = _booking_int("BOOKING_TASK_BATCH_LIMIT", 500, 1, 5000)
# Price (10.5): free minutes at the start, then blocks of ROUNDING minutes (rounded up).
BOOKING_FREE_MINUTES = _booking_int("BOOKING_FREE_MINUTES", 10, 0, 120)
BOOKING_ROUNDING_MINUTES = _booking_int("BOOKING_ROUNDING_MINUTES", 15, 1, 120)
BOOKING_DYNAMIC_THRESHOLD = "0.8"  # occupancy above which the dynamic factor starts
BOOKING_DYNAMIC_SLOPE = "0.5"  # k_band = 1 + slope * (occupancy - threshold)
BOOKING_DYNAMIC_MAX_FACTOR = "1.5"  # upper bound of k_band
# Cancellation policy (6.2). Percentages of the amount actually PAID that are refunded.
BOOKING_CANCEL_FULL_REFUND_MINUTES = _booking_int(
    "BOOKING_CANCEL_FULL_REFUND_MINUTES", 60, 0, 10080
)
BOOKING_CANCEL_FULL_PERCENT = _booking_int("BOOKING_CANCEL_FULL_PERCENT", 100, 0, 100)
BOOKING_CANCEL_LATE_PERCENT = _booking_int("BOOKING_CANCEL_LATE_PERCENT", 50, 0, 100)
BOOKING_CANCEL_AFTER_START_PERCENT = _booking_int("BOOKING_CANCEL_AFTER_START_PERCENT", 0, 0, 100)
# Anti slot-hoarding, counted per user under the lot lock (ARCHITECTURE 10.8).
BOOKING_MAX_PENDING = _booking_int("BOOKING_MAX_PENDING", 2, 1, 20)  # unpaid holds at once
BOOKING_MAX_ACTIVE = _booking_int("BOOKING_MAX_ACTIVE", 5, 1, 100)  # PENDING+CONFIRMED+ACTIVE
# This many abandoned holds (cancelled or expired while unpaid) within the window -> 429 cooldown.
BOOKING_COOLDOWN_THRESHOLD = _booking_int("BOOKING_COOLDOWN_THRESHOLD", 5, 1, 100)
BOOKING_COOLDOWN_WINDOW_MINUTES = _booking_int("BOOKING_COOLDOWN_WINDOW_MINUTES", 10, 1, 1440)
# Extending needs an extra payment, which arrives with payments (Step 8): off until then.
BOOKING_EXTEND_ENABLED = env.bool("BOOKING_EXTEND_ENABLED", default=False)
# Row-lock wait ceiling for POST /bookings (PostgreSQL SET LOCAL lock_timeout), seconds.
BOOKING_LOCK_TIMEOUT_SECONDS = _booking_int("BOOKING_LOCK_TIMEOUT_SECONDS", 5, 1, 60)
# QR (15): token valid from start - EARLY until booking end + GRACE; signed with its own key.
BOOKING_QR_GRACE_MINUTES = _booking_int("BOOKING_QR_GRACE_MINUTES", 30, 0, 720)
BOOKING_QR_EARLY_MINUTES = _booking_int("BOOKING_QR_EARLY_MINUTES", 120, 0, 1440)
# Operator gate (Step 9, ARCHITECTURE 10.8). Check-in is refused earlier than this before the start
# (the QR itself becomes readable BOOKING_QR_EARLY_MINUTES before; this is the gate's own limit).
BOOKING_CHECKIN_EARLY_MINUTES = _booking_int("BOOKING_CHECKIN_EARLY_MINUTES", 30, 0, 240)
# The exit QR (purpose "exit", issued once checked in) lives this long from the moment it is asked
# for: overstaying drivers are past the booking end, so the normal "end + grace" would not do.
BOOKING_QR_EXIT_MINUTES = _booking_int("BOOKING_QR_EXIT_MINUTES", 720, 1, 2880)
# Walk-in (a car without a booking): the period is [now, min(now + MAX, next booking)); it is
# refused when a booking on the slot or of the same plate starts within MIN_GAP.
BOOKING_WALKIN_MAX_HOURS = _booking_int("BOOKING_WALKIN_MAX_HOURS", 4, 1, 48)
BOOKING_WALKIN_MIN_GAP_MINUTES = _booking_int("BOOKING_WALKIN_MIN_GAP_MINUTES", 15, 0, 240)
# A booking that starts within this many minutes of an overstaying car on its slot is moved to
# another free slot of the same type (10.7). 0 disables moving (it is then only logged).
BOOKING_OVERSTAY_REASSIGN_MINUTES = _booking_int("BOOKING_OVERSTAY_REASSIGN_MINUTES", 15, 0, 240)
# Scan brute force: this many bad scans (forged / replaced / foreign QR, unknown booking, wrong
# plate) by one operator within the window lock their scanning for the rest of the window (429).
OPERATOR_SCAN_FAIL_LIMIT = _booking_int("OPERATOR_SCAN_FAIL_LIMIT", 10, 1, 1000)
OPERATOR_SCAN_FAIL_WINDOW_SECONDS = _booking_int(
    "OPERATOR_SCAN_FAIL_WINDOW_SECONDS", 300, 10, 86400
)
# Walk-in: this many minutes before the next booking of the slot the walk-in period ends (the
# car must be gone before the booked driver arrives); a single operator may register at most
# OPERATOR_WALKIN_PER_HOUR walk-ins per hour (429 beyond; a flood is almost certainly abuse).
BOOKING_WALKIN_BUFFER_MINUTES = _booking_int("BOOKING_WALKIN_BUFFER_MINUTES", 5, 0, 60)
OPERATOR_WALKIN_PER_HOUR = _booking_int("OPERATOR_WALKIN_PER_HOUR", 20, 1, 1000)
# Failed walk-in attempts per operator per minute (plate_busy is an oracle for "is this plate booked
# somewhere"): beyond this the operator gets 429 for the rest of the minute.
OPERATOR_WALKIN_FAIL_PER_MINUTE = _booking_int("OPERATOR_WALKIN_FAIL_PER_MINUTE", 10, 1, 1000)
# Overstay longer than this is capped (and flagged for review): a forgotten car must not make the
# price loop endless or overflow the money column.
BOOKING_OVERSTAY_MAX_DAYS = _booking_int("BOOKING_OVERSTAY_MAX_DAYS", 30, 1, 365)
# Staff invitation codes (replace username/phone lookup): life of a code and open codes per lot.
OPERATOR_INVITE_HOURS = _booking_int("OPERATOR_INVITE_HOURS", 72, 1, 168)
OPERATOR_INVITE_MAX_OPEN = _booking_int("OPERATOR_INVITE_MAX_OPEN", 20, 1, 200)
# Wrong invitation codes tried by one account within the window lock accepting for that account.
OPERATOR_INVITE_FAIL_LIMIT = _booking_int("OPERATOR_INVITE_FAIL_LIMIT", 5, 1, 100)
OPERATOR_INVITE_FAIL_WINDOW_SECONDS = _booking_int(
    "OPERATOR_INVITE_FAIL_WINDOW_SECONDS", 3600, 60, 86400
)
# Slot map: bookings starting later than this are not shown as "next".
OPERATOR_MAP_HORIZON_HOURS = _booking_int("OPERATOR_MAP_HORIZON_HOURS", 24, 1, 168)
# The plate of a waiting booking is shown on the map only when it starts this soon.
OPERATOR_MAP_PLATE_HOURS = _booking_int("OPERATOR_MAP_PLATE_HOURS", 2, 1, 24)
OPERATOR_MAP_MAX_SLOTS = _booking_int("OPERATOR_MAP_MAX_SLOTS", 500, 1, 5000)
# Audit rows older than this may be purged by a scheduled job (ARCHITECTURE 15); never auto-deleted.
AUDIT_RETENTION_DAYS = _booking_int("AUDIT_RETENTION_DAYS", 365, 30, 3650)
# Empty = fall back to SECRET_KEY (dev/test); prod.py makes it mandatory (>= 50 characters).
# Rotate by moving the old key to QR_SIGNING_KEY_FALLBACKS (comma separated) for one token life.
QR_SIGNING_KEY = env("QR_SIGNING_KEY", default="")
QR_SIGNING_KEY_FALLBACKS = env.list("QR_SIGNING_KEY_FALLBACKS", default=[])
# Idempotency-Key (10.3): kept 24 h; the in-progress marker must outlive the longest request
# (lock_timeout + statement_timeout), so it is generous and refreshed before the work starts.
BOOKING_IDEMPOTENCY_TTL_SECONDS = 24 * 3600
BOOKING_IDEMPOTENCY_LOCK_SECONDS = 120
BOOKING_IDEMPOTENCY_WAIT_SECONDS = 2.0  # a parallel duplicate waits this long, then 409
VEHICLES_MAX_PER_USER = _booking_int("VEHICLES_MAX_PER_USER", 10, 1, 100)  # soft limit


# --- payments (ARCHITECTURE 6.1, 8.1, 9.1, 15). Secrets come from the environment ONLY; ---------
# prod.py makes the provider credentials mandatory (and checks their length).
PAYMENTS_DEFAULT_PROVIDER = env("PAYMENTS_DEFAULT_PROVIDER", default="payme")
if PAYMENTS_DEFAULT_PROVIDER not in ("payme", "click"):
    raise ImproperlyConfigured("PAYMENTS_DEFAULT_PROVIDER must be 'payme' or 'click'.")
# Sandbox endpoints (test.paycom.uz checkout). Allowed in dev/test only: prod.py refuses it.
PAYMENTS_SANDBOX = env.bool("PAYMENTS_SANDBOX", default=False)
PAYME_MERCHANT_ID = env("PAYME_MERCHANT_ID", default="")  # cash register id (not secret)
PAYME_KEY = env("PAYME_KEY", default="")  # the "password" of Basic auth: SECRET
PAYME_LOGIN = env("PAYME_LOGIN", default="Paycom")  # Basic auth login, fixed by Payme
PAYME_CHECKOUT_URL = env("PAYME_CHECKOUT_URL", default="https://checkout.paycom.uz")
PAYME_SANDBOX_CHECKOUT_URL = "https://test.paycom.uz"
CLICK_SERVICE_ID = env("CLICK_SERVICE_ID", default="")
CLICK_MERCHANT_ID = env("CLICK_MERCHANT_ID", default="")
CLICK_MERCHANT_USER_ID = env("CLICK_MERCHANT_USER_ID", default="")  # Merchant API (reversal)
CLICK_SECRET_KEY = env("CLICK_SECRET_KEY", default="")  # SECRET (sign_string, Auth digest)
CLICK_PAY_URL = "https://my.click.uz/services/pay"
CLICK_API_URL = "https://api.click.uz/v2/merchant"
# Where the provider sends the driver back after paying (deep link or https URL); optional.
PAYMENTS_RETURN_URL = env("PAYMENTS_RETURN_URL", default="")
PAYMENTS_DEFAULT_LANG = env("PAYMENTS_DEFAULT_LANG", default="uz")  # ru | uz | en
if PAYMENTS_DEFAULT_LANG not in ("ru", "uz", "en"):
    raise ImproperlyConfigured("PAYMENTS_DEFAULT_LANG must be ru, uz or en.")
# Provider source IPs (single addresses or CIDR); empty = check disabled (dev/test). Production
# should list them: Payme publishes 185.234.113.1-15; get Click's from CLICK support.
# PAYMENTS_PAYME_IPS / PAYMENTS_CLICK_IPS override the shared list for one provider.
PAYMENTS_PROVIDER_IPS = env.list("PAYMENTS_PROVIDER_IPS", default=[])
PAYMENTS_PAYME_IPS = env.list("PAYMENTS_PAYME_IPS", default=[])
PAYMENTS_CLICK_IPS = env.list("PAYMENTS_CLICK_IPS", default=[])
PAYMENTS_WEBHOOK_MAX_BODY_BYTES = _booking_int(
    "PAYMENTS_WEBHOOK_MAX_BODY_BYTES", 16384, 1024, 1 << 20
)
# Once a provider transaction exists the hold is stretched to at most now + GRACE, never beyond
# created + hold + GRACE (a driver cannot keep a slot by re-opening payment pages).
PAYMENTS_HOLD_GRACE_MINUTES = _booking_int("PAYMENTS_HOLD_GRACE_MINUTES", 5, 0, 60)
PAYMENTS_REFUND_MAX_ATTEMPTS = _booking_int("PAYMENTS_REFUND_MAX_ATTEMPTS", 8, 1, 50)
PAYMENTS_REFUND_BACKOFF_SECONDS = _booking_int("PAYMENTS_REFUND_BACKOFF_SECONDS", 30, 1, 3600)
PAYMENTS_REFUND_HTTP_TIMEOUT_SECONDS = _booking_int(
    "PAYMENTS_REFUND_HTTP_TIMEOUT_SECONDS", 10, 1, 60
)
# retry_failed_webhooks: a PENDING payment/refund older than this (minutes) is looked at.
PAYMENTS_STALE_MINUTES = _booking_int("PAYMENTS_STALE_MINUTES", 15, 1, 1440)
PAYMENTS_TASK_BATCH_LIMIT = _booking_int("PAYMENTS_TASK_BATCH_LIMIT", 200, 1, 5000)
PAYMENTS_CLICK_SIGN_MAX_AGE_HOURS = _booking_int("PAYMENTS_CLICK_SIGN_MAX_AGE_HOURS", 24, 1, 168)
PAYMENTS_STATEMENT_LIMIT = _booking_int("PAYMENTS_STATEMENT_LIMIT", 5000, 1, 100000)
# Webhook / refund transactions wait at most this long for a row lock (SET LOCAL lock_timeout).
PAYMENTS_LOCK_TIMEOUT_SECONDS = _booking_int("PAYMENTS_LOCK_TIMEOUT_SECONDS", 5, 1, 60)
# Refunds MANUAL / FAILED for longer than this many hours are reported by retry_failed_webhooks.
PAYMENTS_ALERT_HOURS = _booking_int("PAYMENTS_ALERT_HOURS", 24, 1, 720)
# WebhookEvent rows older than this are purged by payments.purge_webhook_events (daily).
PAYMENTS_EVENT_RETENTION_DAYS = _booking_int("PAYMENTS_EVENT_RETENTION_DAYS", 90, 1, 3650)


# UNCONFIRMED Click behaviour, therefore configurable and empty by default (see ARCHITECTURE 8.4):
# Merchant API error codes meaning "this payment is already reversed" (treated as a finished
# refund, which makes a repeated reversal after a lost answer harmless), ...
def _click_error_codes(name: str) -> list[int]:
    """Click error codes are NEGATIVE integers; 0 is success and must never mean "already
    reversed" (that would turn every failure into a finished refund)."""
    try:
        codes = [int(code) for code in env.list(name, default=[])]
    except ValueError as exc:
        raise ImproperlyConfigured(f"{name} must be a comma separated list of integers.") from exc
    if any(code >= 0 for code in codes):
        raise ImproperlyConfigured(f"{name} may only contain negative Click error codes.")
    return codes


CLICK_REVERSAL_DONE_CODES = _click_error_codes("CLICK_REVERSAL_DONE_CODES")
# ... and the optional status check before re-sending a reversal (response shape unconfirmed):
CLICK_STATUS_CHECK = env.bool("CLICK_STATUS_CHECK", default=False)
CLICK_STATUS_REVERSED_VALUES = [
    int(value) for value in env.list("CLICK_STATUS_REVERSED_VALUES", default=[])
]
# Redis only redelivers an unacked task after visibility_timeout (default 1 h); refund retries
# back off up to 30 min, so give the broker twice that.
CELERY_BROKER_TRANSPORT_OPTIONS = {
    "visibility_timeout": 7200,
    "socket_timeout": 5,  # a dead broker must fail a publish quickly, not hang the request
    "socket_connect_timeout": 2,
}
# Publishing a task (apply_async inside a request or a hook) retries once, then raises: callers
# catch it and fall back (realtime: send now; notifications: resend_pending picks the row up).
CELERY_TASK_PUBLISH_RETRY_POLICY = {
    "max_retries": 1,
    "interval_start": 0,
    "interval_step": 0.2,
    "interval_max": 0.5,
}
# Queues: default ("celery") for the business sweeps, "realtime" for the 250 ms availability
# flushes, "notify" for outbound Expo / Telegram calls. A slow Telegram never delays a sweep or a
# live update (run one worker per queue, ARCHITECTURE 17). One task per worker slot at a time.
CELERY_TASK_ROUTES = {
    "realtime.*": {"queue": "realtime"},
    "notifications.*": {"queue": "notify"},
}
CELERY_WORKER_PREFETCH_MULTIPLIER = 1


# --- realtime (WebSocket; ARCHITECTURE 12) ------------------------------------------------------
# CHANNEL_LAYERS is set per environment (dev/prod: Redis from REDIS_URL, test: in-memory).
def _ws_int(name: str, default: int, low: int, high: int) -> int:
    return _booking_int(name, default, low, high)


WS_TICKET_TTL_SECONDS = 30  # a ticket is used within seconds of being issued
WS_MAX_GROUPS_PER_CONNECTION = _ws_int("WS_MAX_GROUPS_PER_CONNECTION", 50, 1, 500)
WS_MAX_MESSAGE_BYTES = _ws_int("WS_MAX_MESSAGE_BYTES", 4096, 256, 65536)
WS_MESSAGES_PER_SECOND = _ws_int("WS_MESSAGES_PER_SECOND", 10, 1, 1000)
WS_MAX_CONNECTIONS_PER_USER = _ws_int("WS_MAX_CONNECTIONS_PER_USER", 5, 1, 100)
WS_HEARTBEAT_SECONDS = _ws_int("WS_HEARTBEAT_SECONDS", 30, 1, 600)  # server ping interval
WS_IDLE_TIMEOUT_SECONDS = _ws_int("WS_IDLE_TIMEOUT_SECONDS", 90, 2, 3600)
# A socket is closed (4410) after this long so the client reconnects with a fresh ticket and
# re-subscribes: the Redis channel layer forgets group members after 24 h anyway (redis_urls.py).
WS_MAX_AGE_SECONDS = _ws_int("WS_MAX_AGE_SECONDS", 12 * 3600, 60, 20 * 3600)
# A lot / operator subscription refused for an id is remembered this long per connection, so a
# client hammering random UUIDs costs one database query per id and window, not one per message.
WS_NEGATIVE_CACHE_SECONDS = _ws_int("WS_NEGATIVE_CACHE_SECONDS", 30, 1, 600)
WS_AUTH_TIMEOUT_SECONDS = _ws_int("WS_AUTH_TIMEOUT_SECONDS", 10, 1, 120)  # first-message auth
# Availability messages of one lot closer together than this are coalesced (leading + trailing).
WS_DEBOUNCE_MILLISECONDS = _ws_int("WS_DEBOUNCE_MILLISECONDS", 200, 10, 5000)

# --- notifications (ARCHITECTURE 12.1) ----------------------------------------------------------
# Public base URL of the universal links (https://<host>/b/<booking id>). Prod makes it mandatory
# and https-only; an empty value just means "no link button".
HABI_PUBLIC_URL = env("HABI_PUBLIC_URL", default="")
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_ACCESS_TOKEN = env("EXPO_ACCESS_TOKEN", default="")  # optional; SECRET when set
NOTIFICATION_LOG_RETENTION_DAYS = _booking_int("NOTIFICATION_LOG_RETENTION_DAYS", 180, 7, 3650)
PUSH_TOKEN_MAX_AGE_DAYS = _booking_int("PUSH_TOKEN_MAX_AGE_DAYS", 90, 7, 3650)
NOTIFICATION_REMINDER_MINUTES = _booking_int("NOTIFICATION_REMINDER_MINUTES", 15, 1, 120)
DEVICES_MAX_PER_USER = _booking_int("DEVICES_MAX_PER_USER", 5, 1, 50)  # Expo tokens kept
NOTIFICATION_BATCH_LIMIT = _booking_int("NOTIFICATION_BATCH_LIMIT", 500, 1, 5000)
