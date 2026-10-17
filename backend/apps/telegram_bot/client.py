"""Minimal Telegram Bot API client (httpx)."""

import functools
import logging

import httpx
from django.conf import settings

logger = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org"
DEFAULT_TIMEOUT = 10.0
ALLOWED_UPDATES = ["message"]


class TelegramAPIError(Exception):
    """Bot API failure. Messages never include the URL (it contains the bot token).

    ``status_code`` (HTTP) and ``retry_after`` (seconds, from a 429) let callers tell "the user
    blocked the bot" (403) and "slow down" (429) from other failures without parsing the text.
    """

    def __init__(self, message: str, *, status_code: int | None = None, retry_after=None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


def _retry_after(body) -> int | None:
    parameters = body.get("parameters") if isinstance(body, dict) else None
    value = parameters.get("retry_after") if isinstance(parameters, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


class TelegramClient:
    def __init__(self, token: str, http_client: httpx.Client | None = None):
        self.token = token
        self._http = http_client or httpx.Client(timeout=DEFAULT_TIMEOUT)

    def _call(self, method: str, payload: dict, timeout: float = DEFAULT_TIMEOUT):
        url = f"{API_BASE}/bot{self.token}/{method}"
        try:
            response = self._http.post(url, json=payload, timeout=timeout)
        except httpx.HTTPError as exc:
            raise TelegramAPIError(f"{method}: network error ({type(exc).__name__})") from None
        try:
            body = response.json()
        except ValueError:
            raise TelegramAPIError(
                f"{method}: HTTP {response.status_code}, non-JSON body",
                status_code=response.status_code,
            ) from None
        if not isinstance(body, dict) or not body.get("ok"):
            description = str(body.get("description", "")) if isinstance(body, dict) else ""
            raise TelegramAPIError(
                f"{method}: HTTP {response.status_code} {description[:200]}",
                status_code=response.status_code,
                retry_after=_retry_after(body),
            )
        return body.get("result")

    def send_message(self, chat_id: int, text: str, reply_markup: dict | None = None):
        payload: dict = {"chat_id": chat_id, "text": text}
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        return self._call("sendMessage", payload)

    def set_webhook(self, url: str, secret_token: str):
        payload = {"url": url, "secret_token": secret_token, "allowed_updates": ALLOWED_UPDATES}
        return self._call("setWebhook", payload)

    def delete_webhook(self):
        return self._call("deleteWebhook", {"drop_pending_updates": False})

    def get_updates(self, offset: int | None = None, timeout: int = 30) -> list[dict]:
        payload: dict = {"timeout": timeout, "allowed_updates": ALLOWED_UPDATES}
        if offset is not None:
            payload["offset"] = offset
        return self._call("getUpdates", payload, timeout=timeout + DEFAULT_TIMEOUT) or []


@functools.lru_cache(maxsize=4)
def _build(token: str) -> TelegramClient:
    return TelegramClient(token)


def get_client() -> TelegramClient:
    token = settings.TELEGRAM_BOT_TOKEN
    if not token:
        raise TelegramAPIError("TELEGRAM_BOT_TOKEN is not configured")
    return _build(token)
