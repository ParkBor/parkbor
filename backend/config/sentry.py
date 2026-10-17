"""Sentry setup with scrubbing: Bot API URLs contain the bot token (`/bot<token>/method`)."""

import re
from urllib.parse import urlparse

from django.conf import settings

_BOT_URL_TOKEN = re.compile(r"/bot\d+:[A-Za-z0-9_-]+")
# A WebSocket ticket is a short-lived bearer credential (usually in `?ticket=`); an Expo push token
# identifies a device. Neither belongs in an error report.
_WS_TICKET = re.compile(r"([?&]ticket=)[^&\s\"']+")
_EXPO_TOKEN = re.compile(r"Expo(?:nent)?PushToken\[[^\]]*\]")
REDACTED = "/bot<redacted>"
SECRET_SETTINGS = ("TELEGRAM_BOT_TOKEN", "PAYME_KEY", "CLICK_SECRET_KEY", "EXPO_ACCESS_TOKEN")
MIN_SECRET_LENGTH = 8


def _mask_ticket(match) -> str:
    return match.group(1) + "<redacted>"


def scrub(text: str) -> str:
    """Mask bot tokens, WebSocket tickets, Expo tokens and the configured secrets."""
    cleaned = _BOT_URL_TOKEN.sub(REDACTED, text)
    cleaned = _WS_TICKET.sub(_mask_ticket, cleaned)
    cleaned = _EXPO_TOKEN.sub("<expo-token>", cleaned)
    for name in SECRET_SETTINGS:
        secret = getattr(settings, name, "")
        if secret and len(secret) >= MIN_SECRET_LENGTH:  # never blank out short/test values
            cleaned = cleaned.replace(secret, "<redacted>")
    return cleaned


# Payment callbacks carry credentials in the body / headers (Payme Basic auth, Click sign_string).
# A QR token is a bearer credential for one booking: never send it (operator scan endpoints).
SENSITIVE_KEYS = frozenset(
    {"authorization", "sign_string", "cookie", "x-api-key", "auth", "qr_token", "ticket"}
)
PAYMENT_PATH = "/payments/"
WS_PATH = "/ws/"  # /api/v1/ws/ticket answers with a ticket, /ws/availability/ takes one
# Endpoints whose body carries a bearer secret (a QR token, an invitation code): the whole request
# body is dropped. Exact paths (trailing slash ignored): a suffix match would be easy to dodge.
SECRET_BODY_PATHS = frozenset(
    {
        "/api/v1/operator/checkin",
        "/api/v1/operator/checkout",
        "/api/v1/me/operator-invites/accept",
    }
)


def _scrub_any(value):
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, dict):
        return {
            key: "<redacted>"
            if isinstance(key, str) and key.lower() in SENSITIVE_KEYS
            else _scrub_any(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_scrub_any(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_scrub_any(item) for item in value)
    return value


def _drop_payment_body(event):
    """A payment webhook's body is signed / secret-bearing JSON-RPC or a form, and a scan body
    holds a QR token: never send either."""
    request = event.get("request")
    url = str(request.get("url", "")) if isinstance(request, dict) else ""
    path = urlparse(url).path
    if PAYMENT_PATH in url or path.rstrip("/") in SECRET_BODY_PATHS or WS_PATH in path:
        for part in ("data", "query_string", "cookies"):
            request.pop(part, None)
    return event


def before_send(event, hint):
    return _scrub_any(_drop_payment_body(event))


def before_breadcrumb(crumb, hint):
    return _scrub_any(crumb)


def init_sentry(dsn: str) -> bool:
    """Initialise Sentry only when a DSN is configured; returns whether it was initialised."""
    if not dsn:
        return False
    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn,
        send_default_pii=False,
        include_local_variables=False,  # frames of the webhook code hold keys and request bodies
        before_send=before_send,
        before_breadcrumb=before_breadcrumb,
    )
    return True
