"""Telegram Login Widget verification (admin panel)."""

import hashlib
import hmac
import time

from apps.core.redis_client import get_redis

MAX_AUTH_AGE_SECONDS = 300
_MAX_CLOCK_SKEW_SECONDS = 60


def verify_telegram_widget(data: dict, bot_token: str, *, now: float | None = None) -> bool:
    """True if `data` was signed by Telegram for this bot and is at most 5 minutes old.

    Does not mutate `data`.
    """
    if not bot_token:
        return False
    received_hash = data.get("hash")
    if not isinstance(received_hash, str):
        return False
    fields = {k: v for k, v in data.items() if k != "hash"}
    try:
        age = (time.time() if now is None else now) - int(fields["auth_date"])
    except (KeyError, TypeError, ValueError):
        return False
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hashlib.sha256(bot_token.encode()).digest()
    calculated = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    is_fresh = -_MAX_CLOCK_SKEW_SECONDS <= age < MAX_AUTH_AGE_SECONDS
    return hmac.compare_digest(calculated.encode(), received_hash.encode()) and is_fresh


def consume_widget_hash(widget_hash: str) -> bool:
    """Single-use guard: True only the first time this signed payload is presented."""
    ttl = MAX_AUTH_AGE_SECONDS + _MAX_CLOCK_SKEW_SECONDS
    return bool(get_redis().set(f"tgwidget:{widget_hash}", "1", nx=True, ex=ttl))
