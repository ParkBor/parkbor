"""Fixtures for the real-service concurrency suite (PostgreSQL EXCLUDE constraints, real Redis).

Every test here is marked ``postgis`` and/or ``redis``; tests/conftest.py skips them locally and
turns a missing service into a build failure when REQUIRE_POSTGIS=1 / REQUIRE_REDIS=1 (CI).
"""

import os

import fakeredis
import pytest
import redis
from django.core.cache import cache
from rest_framework.throttling import SimpleRateThrottle

from apps.core import redis_client


@pytest.fixture
def real_redis():
    """A real Redis on a private database; flushed before and after.

    REDIS_TEST_URL must point at a throw-away database that is not db 0 (the broker / channel
    layer database on a shared server): ``flushdb`` runs here.
    """
    client = redis.Redis.from_url(
        os.environ["REDIS_TEST_URL"], decode_responses=True, socket_timeout=5
    )
    assert client.connection_pool.connection_kwargs["db"] != 0, "REDIS_TEST_URL must not use db 0"
    client.flushdb()
    redis_client.set_redis_client(client)
    yield client
    client.flushdb()
    redis_client.set_redis_client(None)


@pytest.fixture(autouse=True)
def _redis_backend(request):
    """redis-marked tests get the real server; the others (PostgreSQL only) a private fake, so
    side effects such as realtime debouncing never reach a shared Redis."""
    if request.node.get_closest_marker("redis"):
        yield request.getfixturevalue("real_redis")
        return
    client = fakeredis.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True)
    redis_client.set_redis_client(client)
    yield client
    redis_client.set_redis_client(None)


@pytest.fixture(autouse=True)
def _clean_throttle_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def generous_throttles(monkeypatch):
    """Dozens of requests in a burst are the point of these tests: lift the per-minute limits."""
    rates = {**SimpleRateThrottle.THROTTLE_RATES}
    for scope in ("booking_create", "booking_mutate", "booking_qr", "booking_quote", "user"):
        rates[scope] = "100000/min"
    monkeypatch.setattr(SimpleRateThrottle, "THROTTLE_RATES", rates)
