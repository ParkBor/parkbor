"""Single access point for the Redis client (swappable with a fake in tests)."""

import redis
from django.conf import settings

REDIS_TIMEOUT_SECONDS = 2

_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    """Return the process-wide Redis client (decoded strings)."""
    global _client  # noqa: PLW0603
    if _client is None:
        _client = redis.Redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_timeout=REDIS_TIMEOUT_SECONDS,
            socket_connect_timeout=REDIS_TIMEOUT_SECONDS,
        )
    return _client


def set_redis_client(client: redis.Redis | None) -> None:
    """Install a client (tests pass a fakeredis instance; None resets to lazy default)."""
    global _client  # noqa: PLW0603
    _client = client
