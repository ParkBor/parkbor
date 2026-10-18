"""Connection registry (atomic Lua script), ratelimit cost, redis URL layout."""

import pytest

from apps.realtime import connections
from apps.realtime.ratelimit import TokenBucket
from config.settings import redis_urls


@pytest.fixture(autouse=True)
def _limit(settings):
    settings.WS_MAX_CONNECTIONS_PER_USER = 2
    settings.WS_HEARTBEAT_SECONDS = 30
    settings.WS_IDLE_TIMEOUT_SECONDS = 90


def test_connections_up_to_the_limit_are_kept(fake_redis):
    assert connections.register("u", "a", now=100) == []
    assert connections.register("u", "b", now=101) == []
    assert fake_redis.zcard("ws:conns:u") == 2


def test_the_oldest_beyond_the_limit_is_returned_and_removed(fake_redis):
    connections.register("u", "a", now=100)
    connections.register("u", "b", now=101)
    assert connections.register("u", "c", now=102) == ["a"]
    assert set(fake_redis.zrange("ws:conns:u", 0, -1)) == {"b", "c"}


def test_a_new_connection_is_never_its_own_victim(fake_redis):
    connections.register("u", "a", now=100)
    connections.register("u", "b", now=100)
    assert "c" not in connections.register("u", "c", now=100)


def test_a_clock_skewed_newcomer_is_scored_above_the_newest_entry(fake_redis):
    connections.register("u", "a", now=1000)
    connections.register("u", "b", now=1001)
    assert connections.register("u", "late", now=10) == ["a"]  # the oldest goes, not the newcomer
    assert set(fake_redis.zrange("ws:conns:u", 0, -1)) == {"b", "late"}
    assert fake_redis.zscore("ws:conns:u", "late") > fake_redis.zscore("ws:conns:u", "b")


def test_if_the_newcomer_is_ever_chosen_it_is_returned_to_be_closed(fake_redis, monkeypatch):
    monkeypatch.setattr(fake_redis, "eval", lambda *args: ["me", "other"])
    assert connections.register("u", "me") == ["me", "other"]


def test_dead_entries_are_dropped_without_evicting_live_ones(fake_redis):
    connections.register("u", "dead1", now=100)
    connections.register("u", "dead2", now=101)
    # far later: both heartbeats stopped, so the newcomer fits and nobody live is evicted
    assert connections.register("u", "live", now=100 + 10_000) == []
    assert fake_redis.zrange("ws:conns:u", 0, -1) == ["live"]


def test_the_key_expires(fake_redis):
    connections.register("u", "a", now=100)
    assert 0 < fake_redis.ttl("ws:conns:u") <= connections.KEY_TTL_SECONDS


def test_users_are_independent(fake_redis):
    connections.register("u", "a", now=1)
    connections.register("u", "b", now=2)
    assert connections.register("v", "c", now=3) == []


def test_touch_refreshes_the_score_but_never_resurrects_an_evicted_entry(fake_redis):
    connections.register("u", "a", now=100)
    connections.touch("u", "a", now=500)
    assert fake_redis.zscore("ws:conns:u", "a") == 500
    connections.unregister("u", "a")
    connections.touch("u", "a", now=600)  # XX: it must not come back
    assert fake_redis.zscore("ws:conns:u", "a") is None


def test_a_recently_touched_connection_outlives_a_silent_one(fake_redis):
    connections.register("u", "old", now=100)
    connections.register("u", "busy", now=101)
    connections.touch("u", "busy", now=120)
    assert connections.register("u", "new", now=130) == ["old"]


def test_store_errors_are_swallowed(fake_redis, monkeypatch):
    import redis

    def boom(*a, **k):
        raise redis.ConnectionError("down")

    monkeypatch.setattr(fake_redis, "eval", boom)
    monkeypatch.setattr(fake_redis, "zrem", boom)
    monkeypatch.setattr(fake_redis, "zadd", boom)
    assert connections.register("u", "a") == []
    connections.unregister("u", "a")
    connections.touch("u", "a")


# --- token bucket cost -----------------------------------------------------------------------


def test_a_costly_message_needs_the_tokens():
    now = [0.0]
    bucket = TokenBucket(10, clock=lambda: now[0])
    assert bucket.allow(6) is True
    assert bucket.allow(6) is False  # only 4 left
    assert bucket.allow(4) is True


def test_cost_is_capped_at_the_bucket_size_so_a_full_bucket_always_passes():
    bucket = TokenBucket(10, clock=lambda: 0.0)
    assert bucket.allow(500) is True
    assert bucket.allow(1) is False


# --- redis urls -----------------------------------------------------------------------------


def test_with_db_replaces_only_the_database():
    assert redis_urls.with_db("redis://:pw@host:6380/0", 2) == "redis://:pw@host:6380/2"
    assert redis_urls.with_db("rediss://host:6379", 3) == "rediss://host:6379/3"
    assert redis_urls.with_db("redis://host/7?x=1", 1) == "redis://host/1?x=1"


def test_the_roles_use_distinct_database_numbers():
    numbers = {
        redis_urls.DB_BROKER,
        redis_urls.DB_CHANNELS,
        redis_urls.DB_CACHE,
        redis_urls.DB_STATE,
    }
    assert len(numbers) == 4
