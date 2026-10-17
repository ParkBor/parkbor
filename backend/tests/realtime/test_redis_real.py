"""Behaviour on a REAL Redis (CI service; skipped locally without REDIS_TEST_URL): the ticket
store (SET NX / GETDEL), the connection registry, the debounce window and the Redis channel
layer. Everything else runs against fakeredis / the in-memory layer."""

import asyncio
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import redis

from apps.core import redis_client
from apps.realtime import connections, publishers, tickets

pytestmark = pytest.mark.redis


@pytest.fixture
def real_redis():
    client = redis.Redis.from_url(os.environ["REDIS_TEST_URL"], decode_responses=True)
    client.flushdb()
    redis_client.set_redis_client(client)
    yield client
    client.flushdb()
    redis_client.set_redis_client(None)


def test_ticket_is_stored_with_a_real_ttl_and_works_once(real_redis):
    ticket = tickets.issue_ticket("user-1")
    keys = real_redis.keys("ws:ticket:*")
    assert len(keys) == 1 and 0 < real_redis.ttl(keys[0]) <= 30
    assert tickets.consume_ticket(ticket) == "user-1"
    assert tickets.consume_ticket(ticket) is None


def test_racing_consumers_cannot_both_use_a_ticket(real_redis):
    ticket = tickets.issue_ticket("user-1")
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda _: tickets.consume_ticket(ticket), range(32)))
    assert results.count("user-1") == 1


def test_set_nx_never_overwrites_an_existing_ticket(real_redis):
    key = "ws:ticket:abc"
    assert real_redis.set(key, "a", nx=True, ex=30) is True
    assert real_redis.set(key, "b", nx=True, ex=30) is None
    assert real_redis.get(key) == "a"


def test_connection_registry_evicts_the_oldest(real_redis, settings):
    settings.WS_MAX_CONNECTIONS_PER_USER = 2
    assert connections.register("u", "ch-1") == []
    assert connections.register("u", "ch-2") == []
    assert connections.register("u", "ch-3") == ["ch-1"]
    assert set(real_redis.zrange("ws:conns:u", 0, -1)) == {"ch-2", "ch-3"}


def test_the_send_window_opens_once_per_debounce_period(real_redis, settings):
    settings.WS_DEBOUNCE_MILLISECONDS = 5000
    lot = uuid.uuid4()
    assert publishers._claim_send_window(lot) is True
    assert publishers._claim_send_window(lot) is False
    assert real_redis.pttl(f"rt:avail:last:{lot}") <= 5000


@pytest.mark.asyncio
async def test_redis_channel_layer_delivers_group_messages():
    from channels_redis.core import RedisChannelLayer

    layer = RedisChannelLayer(hosts=[os.environ["REDIS_TEST_URL"]], prefix="habi-test")
    channel = await layer.new_channel()
    await layer.group_add("lot_x", channel)
    await layer.group_send("lot_x", {"type": "realtime.event", "payload": {"n": 1}})
    message = await asyncio.wait_for(layer.receive(channel), 5)
    assert message["payload"] == {"n": 1}
    await layer.group_discard("lot_x", channel)
    await layer.flush()
