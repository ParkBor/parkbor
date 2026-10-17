"""Routing tests need only a fake Redis (circuit breaker); no real OSRM."""

from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
