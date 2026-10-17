import json
from io import StringIO

import httpx
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.telegram_bot import client as client_module
from apps.telegram_bot.client import TelegramAPIError, TelegramClient
from tests.auth_fixtures import BOT_TOKEN, WEBHOOK_SECRET


def make_client(handler):
    return TelegramClient(
        BOT_TOKEN, http_client=httpx.Client(transport=httpx.MockTransport(handler))
    )


def ok(result=True):
    return httpx.Response(200, json={"ok": True, "result": result})


def test_send_message_posts_to_bot_api():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return ok({"message_id": 1})

    make_client(handler).send_message(5, "hi", reply_markup={"remove_keyboard": True})
    assert seen["url"] == f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    assert seen["body"] == {"chat_id": 5, "text": "hi", "reply_markup": {"remove_keyboard": True}}


def test_set_webhook_sends_secret_token_and_allowed_updates():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return ok()

    make_client(handler).set_webhook("https://api.habi.uz/api/v1/telegram/webhook", WEBHOOK_SECRET)
    assert seen["body"]["secret_token"] == WEBHOOK_SECRET
    assert seen["body"]["url"].endswith("/telegram/webhook")
    assert seen["body"]["allowed_updates"] == ["message"]


def test_api_error_raised_without_leaking_token():
    client = make_client(
        lambda r: httpx.Response(401, json={"ok": False, "description": "Unauthorized"})
    )
    with pytest.raises(TelegramAPIError) as exc:
        client.send_message(1, "x")
    assert BOT_TOKEN not in str(exc.value)


def test_network_error_raised_without_leaking_token():
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(TelegramAPIError) as exc:
        make_client(handler).send_message(1, "x")
    assert BOT_TOKEN not in str(exc.value)
    assert BOT_TOKEN not in repr(exc.value.__cause__)


def test_non_json_response_is_api_error():
    with pytest.raises(TelegramAPIError):
        make_client(lambda r: httpx.Response(502, text="<html>")).send_message(1, "x")


def test_get_updates_returns_result_list():
    client = make_client(lambda r: ok([{"update_id": 3}]))
    assert client.get_updates(offset=1, timeout=0) == [{"update_id": 3}]


def test_get_client_requires_bot_token(settings):
    settings.TELEGRAM_BOT_TOKEN = ""
    with pytest.raises(TelegramAPIError):
        client_module.get_client()


def test_get_client_uses_configured_token():
    assert client_module.get_client().token == BOT_TOKEN


# ---- management commands -----------------------------------------------------------------------


class RecordingClient:
    def __init__(self):
        self.calls = []

    def set_webhook(self, url, secret_token):
        self.calls.append(("set", url, secret_token))

    def delete_webhook(self):
        self.calls.append(("delete",))


def test_set_telegram_webhook_command(monkeypatch):
    rec = RecordingClient()
    monkeypatch.setattr(client_module, "get_client", lambda: rec)
    out = StringIO()
    call_command("set_telegram_webhook", "--base-url", "https://api.habi.uz", stdout=out)
    assert rec.calls == [("set", "https://api.habi.uz/api/v1/telegram/webhook", WEBHOOK_SECRET)]
    assert WEBHOOK_SECRET not in out.getvalue()


def test_set_telegram_webhook_requires_https(monkeypatch):
    monkeypatch.setattr(client_module, "get_client", lambda: RecordingClient())
    with pytest.raises(CommandError):
        call_command("set_telegram_webhook", "--base-url", "http://api.habi.uz")


def test_set_telegram_webhook_requires_secret(monkeypatch, settings):
    settings.TELEGRAM_WEBHOOK_SECRET = ""
    monkeypatch.setattr(client_module, "get_client", lambda: RecordingClient())
    with pytest.raises(CommandError):
        call_command("set_telegram_webhook", "--base-url", "https://api.habi.uz")


def test_set_telegram_webhook_delete(monkeypatch):
    rec = RecordingClient()
    monkeypatch.setattr(client_module, "get_client", lambda: rec)
    call_command("set_telegram_webhook", "--delete")
    assert rec.calls == [("delete",)]


class PollingClient:
    def __init__(self, batches):
        self.batches = list(batches)
        self.offsets = []
        self.deleted = False
        self.sent = []

    def delete_webhook(self):
        self.deleted = True

    def get_updates(self, offset=None, timeout=30):
        self.offsets.append(offset)
        return self.batches.pop(0) if self.batches else []

    def send_message(self, chat_id, text, reply_markup=None):
        self.sent.append(text)


@pytest.mark.django_db
def test_run_bot_polling_processes_updates_and_advances_offset(monkeypatch):
    update = lambda uid: {  # noqa: E731
        "update_id": uid,
        "message": {
            "from": {"id": 5, "first_name": "A"},
            "chat": {"id": 5, "type": "private"},
            "text": "/start",
        },
    }
    polling = PollingClient([[update(10), update(11)], []])
    monkeypatch.setattr(client_module, "get_client", lambda: polling)
    call_command("run_bot_polling", "--max-iterations", "2", "--timeout", "0")
    assert polling.deleted is True
    assert polling.offsets == [None, 12]
    assert len(polling.sent) == 2


@pytest.mark.django_db
def test_run_bot_polling_survives_handler_errors(monkeypatch):
    from apps.telegram_bot import handlers

    polling = PollingClient([[{"update_id": 1, "message": {}}, {"update_id": 2}], []])
    monkeypatch.setattr(client_module, "get_client", lambda: polling)
    monkeypatch.setattr(handlers, "handle_update", lambda u, c: 1 / 0)
    call_command("run_bot_polling", "--max-iterations", "2", "--timeout", "0")
    assert polling.offsets == [None, 3]
