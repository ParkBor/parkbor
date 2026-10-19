"""Telegram channel: result classification (blocked bot, rate limit) and the inline button."""

import httpx
import pytest

from apps.notifications.channels import telegram
from apps.notifications.channels.telegram import TelegramOutcome
from apps.telegram_bot import client as client_module
from apps.telegram_bot.client import TelegramAPIError, TelegramClient


class FakeBot:
    def __init__(self, error=None):
        self.error = error
        self.sent = []

    def send_message(self, chat_id, text, reply_markup=None):
        if self.error is not None:
            raise self.error
        self.sent.append({"chat_id": chat_id, "text": text, "reply_markup": reply_markup})


@pytest.fixture
def bot(monkeypatch):
    fake = FakeBot()
    monkeypatch.setattr(client_module, "get_client", lambda: fake)
    return fake


def test_message_is_sent_with_an_inline_link_button(bot):
    result = telegram.send(
        42, "Title\nBody", button_label="Open booking", button_url="https://parkbor.test/b/1"
    )
    assert result.outcome is TelegramOutcome.OK
    assert bot.sent == [
        {
            "chat_id": 42,
            "text": "Title\nBody",
            "reply_markup": {
                "inline_keyboard": [[{"text": "Open booking", "url": "https://parkbor.test/b/1"}]]
            },
        }
    ]


def test_no_button_without_a_link(bot):
    telegram.send(42, "x", button_label="Open", button_url=None)
    assert bot.sent[0]["reply_markup"] is None


def test_only_https_urls_become_buttons(bot):
    telegram.send(42, "x", button_label="Open", button_url="parkbor://booking/1")
    assert bot.sent[0]["reply_markup"] is None  # Telegram would reject a custom scheme


def test_a_blocked_bot_is_reported_as_blocked(monkeypatch):
    fake = FakeBot(TelegramAPIError("sendMessage: HTTP 403 Forbidden", status_code=403))
    monkeypatch.setattr(client_module, "get_client", lambda: fake)
    result = telegram.send(42, "x")
    assert result.outcome is TelegramOutcome.BLOCKED


def test_rate_limit_carries_retry_after(monkeypatch):
    fake = FakeBot(TelegramAPIError("429", status_code=429, retry_after=17))
    monkeypatch.setattr(client_module, "get_client", lambda: fake)
    result = telegram.send(42, "x")
    assert result.outcome is TelegramOutcome.RETRY and result.retry_after == 17


@pytest.mark.parametrize(
    "error",
    [
        TelegramAPIError("network error", status_code=None),
        TelegramAPIError("HTTP 502", status_code=502),
        TelegramAPIError("HTTP 429", status_code=429),
    ],
)
def test_transient_failures_are_retried(monkeypatch, error):
    monkeypatch.setattr(client_module, "get_client", lambda: FakeBot(error))
    assert telegram.send(42, "x").outcome is TelegramOutcome.RETRY


def test_chat_not_found_is_permanent(monkeypatch):
    error = TelegramAPIError("HTTP 400 Bad Request: chat not found", status_code=400)
    monkeypatch.setattr(client_module, "get_client", lambda: FakeBot(error))
    result = telegram.send(42, "x")
    assert result.outcome is TelegramOutcome.FAILED and result.error == "telegram_400"


def test_missing_bot_token_is_a_permanent_failure(monkeypatch):
    def no_token():
        raise TelegramAPIError("TELEGRAM_BOT_TOKEN is not configured")

    monkeypatch.setattr(client_module, "get_client", no_token)
    assert telegram.send(42, "x").outcome is TelegramOutcome.FAILED


def test_the_result_never_contains_the_chat_id_or_text(monkeypatch):
    error = TelegramAPIError("sendMessage: HTTP 400 chat 424242 secret text", status_code=400)
    monkeypatch.setattr(client_module, "get_client", lambda: FakeBot(error))
    result = telegram.send(424242, "secret text")
    assert "424242" not in repr(result) and "secret" not in repr(result)


# --- the real client keeps status and Retry-After on its errors --------------------------------


def test_client_error_carries_status_and_retry_after():
    def handler(request):
        return httpx.Response(
            429,
            json={
                "ok": False,
                "error_code": 429,
                "description": "Too Many Requests: retry after 9",
                "parameters": {"retry_after": 9},
            },
        )

    bot = TelegramClient(
        "1:TOKEN", http_client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    with pytest.raises(TelegramAPIError) as info:
        bot.send_message(1, "x")
    assert (info.value.status_code, info.value.retry_after) == (429, 9)
    assert "TOKEN" not in str(info.value)


def test_client_403_has_status_403():
    def handler(request):
        return httpx.Response(
            403, json={"ok": False, "description": "Forbidden: bot was blocked by the user"}
        )

    bot = TelegramClient(
        "1:TOKEN", http_client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    with pytest.raises(TelegramAPIError) as info:
        bot.send_message(1, "x")
    assert info.value.status_code == 403 and info.value.retry_after is None


def test_client_non_json_failure_keeps_the_status():
    bot = TelegramClient(
        "1:TOKEN",
        http_client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(502))),
    )
    with pytest.raises(TelegramAPIError) as info:
        bot.send_message(1, "x")
    assert info.value.status_code == 502
