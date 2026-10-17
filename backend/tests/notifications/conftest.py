from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.utils import timezone

from apps.accounts.models import Device
from apps.notifications.channels import expo_push, telegram
from apps.notifications.channels.expo_push import PushOutcome, PushResult
from apps.notifications.channels.telegram import TelegramOutcome, TelegramResult
from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.helpers import make_user

TOKEN = "ExponentPushToken[device-one]"
TOKEN_2 = "ExponentPushToken[device-two]"


class FakeExpo:
    """Records every push; ``results`` (outcomes per call) can be scripted."""

    def __init__(self):
        self.calls: list[list[expo_push.PushMessage]] = []
        self.script: list[PushOutcome | PushResult | Exception] = []
        self.by_token: dict[str, PushResult] = {}  # per-device answers, beat the script

    def send(self, messages):
        self.calls.append(list(messages))
        if self.by_token:
            return [self.by_token.get(m.token, PushResult(PushOutcome.OK)) for m in messages]
        outcome = self.script.pop(0) if self.script else PushOutcome.OK
        if isinstance(outcome, Exception):
            raise outcome
        return [
            outcome
            if isinstance(outcome, PushResult)
            else PushResult(outcome, "" if outcome is PushOutcome.OK else str(outcome))
            for _ in messages
        ]

    @property
    def messages(self):
        return [m for call in self.calls for m in call]


class FakeTelegram:
    def __init__(self):
        self.sent: list[dict] = []
        self.script: list[TelegramOutcome | TelegramResult] = []

    def send(self, chat_id, text, *, button_label=None, button_url=None):
        self.sent.append(
            {"chat_id": chat_id, "text": text, "label": button_label, "url": button_url}
        )
        outcome = self.script.pop(0) if self.script else TelegramOutcome.OK
        if isinstance(outcome, TelegramResult):
            return outcome
        return TelegramResult(outcome, "" if outcome is TelegramOutcome.OK else f"tg_{outcome}")


# These modules test the real channel clients (over a mock transport): no fakes there.
REAL_CHANNEL_MODULES = ("test_expo_push", "test_telegram_channel")


def _faked(request) -> bool:
    return request.module.__name__.rsplit(".", 1)[-1] not in REAL_CHANNEL_MODULES


@pytest.fixture(autouse=True)
def expo(monkeypatch, request):
    fake = FakeExpo()
    if _faked(request):
        monkeypatch.setattr(expo_push, "send", fake.send)
    return fake


@pytest.fixture(autouse=True)
def tg(monkeypatch, request):
    fake = FakeTelegram()
    if _faked(request):
        monkeypatch.setattr(telegram, "send", fake.send)
    return fake


@pytest.fixture
def enqueued(monkeypatch):
    """Capture send_notification enqueues instead of using the in-memory broker."""
    from apps.notifications import tasks

    calls = []
    monkeypatch.setattr(
        tasks.send_notification,
        "apply_async",
        lambda args=None, countdown=None, **kw: calls.append((args, countdown)),
    )
    return calls


def make_driver(*, devices=(), telegram_on=False, language="uz", **extra):
    user = make_user("DRIVER", language=language, tg_notifications=telegram_on, **extra)
    for token in devices:
        Device.objects.create(user=user, platform="android", expo_push_token=token)
    return user


@pytest.fixture
def now():
    return timezone.now().replace(microsecond=0)


@pytest.fixture
def times(now):
    return SimpleNamespace(now=now, later=now + timedelta(hours=1))
