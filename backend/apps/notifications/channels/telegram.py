"""Telegram bot channel: sends through ``apps.telegram_bot.client`` and classifies the answer.

The result never carries the chat id, the text or the bot URL (it contains the bot token).
"""

import logging
from dataclasses import dataclass
from enum import StrEnum

from apps.telegram_bot import client as bot_client
from apps.telegram_bot.client import TelegramAPIError

logger = logging.getLogger(__name__)

DEFAULT_RETRY_SECONDS = 5


class TelegramOutcome(StrEnum):
    OK = "ok"
    BLOCKED = "blocked"  # 403: the user blocked the bot (or deleted the chat)
    RETRY = "retry"  # 429 / 5xx / network
    FAILED = "failed"  # permanent (bad chat id, bot token missing, ...)


@dataclass(frozen=True)
class TelegramResult:
    outcome: TelegramOutcome
    error: str = ""
    retry_after: float | None = None


def _markup(label: str | None, url: str | None) -> dict | None:
    # Telegram accepts http(s) links on URL buttons only (a habi:// deep link would be refused).
    if not label or not url or not url.startswith("https://"):
        return None
    return {"inline_keyboard": [[{"text": label, "url": url}]]}


def send(
    chat_id: int, text: str, *, button_label: str | None = None, button_url: str | None = None
) -> TelegramResult:
    try:
        bot_client.get_client().send_message(
            chat_id, text, reply_markup=_markup(button_label, button_url)
        )
    except TelegramAPIError as exc:
        return _classify(exc)
    return TelegramResult(TelegramOutcome.OK)


def _classify(exc: TelegramAPIError) -> TelegramResult:
    status = exc.status_code
    if status == 403:
        return TelegramResult(TelegramOutcome.BLOCKED, "telegram_403")
    if status == 429:
        retry = exc.retry_after if exc.retry_after else DEFAULT_RETRY_SECONDS
        return TelegramResult(TelegramOutcome.RETRY, "telegram_429", retry_after=retry)
    if status is None or status >= 500:
        if status is None and "not configured" in str(exc):
            return TelegramResult(TelegramOutcome.FAILED, "bot_not_configured")
        return TelegramResult(TelegramOutcome.RETRY, f"telegram_{status or 'network'}")
    logger.warning("telegram: HTTP %s", status)
    return TelegramResult(TelegramOutcome.FAILED, f"telegram_{status}")
