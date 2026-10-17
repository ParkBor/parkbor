"""Shared fixtures for Telegram auth tests: fake Redis, cache reset, fake bot client."""

import fakeredis
import pytest
from django.core.cache import cache

from apps.core import redis_client

BOT_TOKEN = "123456:TEST-TOKEN"
WEBHOOK_SECRET = "test-webhook-secret"


class FakeTelegramClient:
    """Records outgoing Bot API calls instead of hitting the network."""

    def __init__(self):
        self.sent = []

    def send_message(self, chat_id, text, reply_markup=None):
        self.sent.append({"chat_id": chat_id, "text": text, "reply_markup": reply_markup})

    @property
    def last(self):
        return self.sent[-1]


@pytest.fixture(autouse=True)
def fake_redis():
    client = fakeredis.FakeRedis(decode_responses=True)
    redis_client.set_redis_client(client)
    yield client
    redis_client.set_redis_client(None)


@pytest.fixture(autouse=True)
def clear_throttle_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def tg_client(monkeypatch):
    from apps.telegram_bot import client as client_module

    fake = FakeTelegramClient()
    monkeypatch.setattr(client_module, "get_client", lambda: fake)
    return fake
