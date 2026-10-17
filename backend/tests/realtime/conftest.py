import pytest

from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401


@pytest.fixture(autouse=True)
def fresh_channel_layer():
    """Every test gets an empty in-memory channel layer (the layer object is process-wide)."""
    from channels.layers import channel_layers

    channel_layers.backends = {}
    yield
    channel_layers.backends = {}


class RecordingLayer:
    """Stands in for the channel layer: records every group_send (or raises, if told to)."""

    def __init__(self):
        self.sent: list[tuple[str, dict]] = []
        self.error: Exception | None = None

    async def group_send(self, group, message):
        if self.error is not None:
            raise self.error
        self.sent.append((group, message))

    def payloads(self, group=None):
        return [m["payload"] for g, m in self.sent if group is None or g == group]


@pytest.fixture
def layer(monkeypatch):
    from apps.realtime import publishers

    recording = RecordingLayer()
    monkeypatch.setattr(publishers, "get_channel_layer", lambda: recording)
    return recording
