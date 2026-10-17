import hmac
import logging

from django.conf import settings

from apps.telegram_bot import client as bot_client
from apps.telegram_bot import handlers

logger = logging.getLogger(__name__)

SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token"  # noqa: S105 - header name, not a secret


def is_valid_secret(provided: str | None) -> bool:
    """Constant-time check of the webhook secret; fails closed when it is not configured."""
    expected = settings.TELEGRAM_WEBHOOK_SECRET
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())


def process_update(update: dict) -> None:
    """Run the handlers; never raise (Telegram would retry the same update endlessly)."""
    try:
        handlers.handle_update(update, bot_client.get_client())
    except Exception:
        logger.exception("telegram update %s failed", update.get("update_id"))
