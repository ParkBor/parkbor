"""Deep links (kept free of Django models so settings/prod.py may import it)."""

import uuid
from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

APP_SCHEME = "parkbor"


def validate_public_url(value: str) -> str:
    """HABI_PUBLIC_URL for production: an https URL with a host, no query/fragment; returns it
    without a trailing slash."""
    parts = urlsplit(value or "")
    if parts.scheme != "https" or not parts.hostname or parts.query or parts.fragment:
        raise ImproperlyConfigured(
            "HABI_PUBLIC_URL must be an https URL such as https://parkbor.uz (universal links)."
        )
    return value.rstrip("/")


def _booking_uuid(booking_id) -> uuid.UUID:
    if not isinstance(booking_id, str | uuid.UUID):
        raise ValueError("booking id must be a UUID")
    return uuid.UUID(str(booking_id))


def booking_deep_link(booking_id) -> str:
    """``parkbor://booking/<id>``: put in the push ``data.url``; the app routes it (Expo Router)."""
    return f"{APP_SCHEME}://booking/{_booking_uuid(booking_id)}"


def booking_universal_link(booking_id) -> str | None:
    """``https://<HABI_PUBLIC_URL>/b/<id>``: Telegram buttons accept only http(s) URLs. None when
    no public URL is configured (the button is then simply left out)."""
    base = (settings.HABI_PUBLIC_URL or "").rstrip("/")
    booking = _booking_uuid(booking_id)
    return f"{base}/b/{booking}" if base else None
