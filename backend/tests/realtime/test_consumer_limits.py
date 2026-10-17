"""Abuse limits: message size, shape, rate, connection cap, heartbeat and idle timeout."""

import json

import pytest
from asgiref.sync import sync_to_async

from apps.realtime import connections
from tests.helpers import make_user
from tests.realtime.ws_helpers import expect_close, new_communicator, open_socket, send

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


@pytest.fixture
def driver():
    return make_user("DRIVER")


# --- message validation ---------------------------------------------------------------------


async def test_ping_gets_pong_and_pong_is_silent(driver, fake_redis):
    comm = await open_socket(driver)
    await send(comm, type="ping")
    assert await comm.receive_json_from() == {"type": "pong"}
    await send(comm, type="pong")
    assert await comm.receive_nothing(timeout=0.1)
    await comm.disconnect()


async def test_oversized_message_closes_1009(driver, settings, fake_redis):
    settings.WS_MAX_MESSAGE_BYTES = 256
    comm = await open_socket(driver)
    await comm.send_to(text_data=json.dumps({"type": "ping", "pad": "x" * 300}))
    await expect_close(comm, 1009)


async def test_multibyte_text_is_measured_in_bytes(driver, settings, fake_redis):
    settings.WS_MAX_MESSAGE_BYTES = 256
    comm = await open_socket(driver)
    # 100 characters but 300 bytes in UTF-8
    await comm.send_to(text_data=json.dumps({"type": "ping", "pad": "€" * 90}, ensure_ascii=False))
    await expect_close(comm, 1009)


async def test_message_exactly_at_the_limit_is_accepted(driver, settings, fake_redis):
    settings.WS_MAX_MESSAGE_BYTES = 256
    comm = await open_socket(driver)
    body = json.dumps({"type": "ping", "pad": ""})
    padded = json.dumps({"type": "ping", "pad": "x" * (256 - len(body))})
    assert len(padded.encode()) == 256
    await comm.send_to(text_data=padded)
    assert await comm.receive_json_from() == {"type": "pong"}
    await comm.disconnect()


@pytest.mark.parametrize(
    "raw", ["not json", "{", "[1,2]", '"str"', "42", "null", '{"type": 5}', "{}"]
)
async def test_malformed_messages_close_4400(driver, fake_redis, raw):
    comm = await open_socket(driver)
    await comm.send_to(text_data=raw)
    await expect_close(comm, 4400)


async def test_binary_frames_close_4400(driver, fake_redis):
    comm = await open_socket(driver)
    await comm.send_to(bytes_data=b"\x00\x01")
    await expect_close(comm, 4400)


async def test_unknown_type_is_answered_and_ignored(driver, fake_redis):
    comm = await open_socket(driver)
    await send(comm, type="shout")
    assert await comm.receive_json_from() == {"type": "error", "code": "unknown_type"}
    await send(comm, type="ping")
    assert await comm.receive_json_from() == {"type": "pong"}
    await comm.disconnect()


async def test_flooding_closes_4429(driver, settings, fake_redis):
    settings.WS_MESSAGES_PER_SECOND = 5
    comm = await open_socket(driver)
    for _ in range(40):
        await send(comm, type="pong")
    while True:
        event = await comm.receive_output(2)
        if event["type"] == "websocket.close":
            assert event["code"] == 4429
            break


# --- connection cap --------------------------------------------------------------------------


async def test_the_oldest_connection_is_closed_beyond_the_cap(driver, settings, fake_redis):
    settings.WS_MAX_CONNECTIONS_PER_USER = 2
    first = await open_socket(driver)
    second = await open_socket(driver)
    third = await open_socket(driver)
    await expect_close(first, 4409)
    await send(second, type="ping")
    assert await second.receive_json_from() == {"type": "pong"}
    await send(third, type="ping")
    assert await third.receive_json_from() == {"type": "pong"}
    await second.disconnect()
    await third.disconnect()


async def test_other_users_do_not_count_against_the_cap(driver, settings, fake_redis):
    settings.WS_MAX_CONNECTIONS_PER_USER = 1
    mine = await open_socket(driver)
    theirs = await open_socket(await sync_to_async(make_user)("DRIVER"))
    await send(mine, type="ping")
    assert await mine.receive_json_from() == {"type": "pong"}
    await mine.disconnect()
    await theirs.disconnect()


async def test_disconnect_frees_a_slot_in_the_registry(driver, settings, fake_redis):
    settings.WS_MAX_CONNECTIONS_PER_USER = 1
    first = await open_socket(driver)
    await first.disconnect()
    assert fake_redis.zcard(f"ws:conns:{driver.pk}") == 0
    second = await open_socket(driver)
    await send(second, type="ping")
    assert await second.receive_json_from() == {"type": "pong"}
    await second.disconnect()


async def test_redis_down_does_not_block_connecting(driver, fake_redis, monkeypatch):
    import redis

    def boom(*a, **k):
        raise redis.ConnectionError("down")

    monkeypatch.setattr(connections, "get_redis", boom)
    comm = await open_socket(driver)
    await comm.disconnect()


# --- heartbeat / idle -----------------------------------------------------------------------


async def test_server_pings_periodically(driver, settings, fake_redis):
    settings.WS_HEARTBEAT_SECONDS = 0.2
    settings.WS_IDLE_TIMEOUT_SECONDS = 30
    comm = await open_socket(driver)
    assert await comm.receive_json_from(timeout=2) == {"type": "ping"}
    await comm.disconnect()


async def test_a_silent_client_is_closed_4408(driver, settings, fake_redis):
    settings.WS_HEARTBEAT_SECONDS = 0.1
    settings.WS_IDLE_TIMEOUT_SECONDS = 0.35
    comm = await open_socket(driver)
    while True:
        event = await comm.receive_output(2)
        if event["type"] == "websocket.close":
            assert event["code"] == 4408
            break


async def test_a_client_that_answers_stays_connected(driver, settings, fake_redis):
    settings.WS_HEARTBEAT_SECONDS = 0.1
    settings.WS_IDLE_TIMEOUT_SECONDS = 0.35
    comm = await open_socket(driver)
    for _ in range(8):
        message = await comm.receive_json_from(timeout=2)
        assert message == {"type": "ping"}
        await send(comm, type="pong")
    await comm.disconnect()


async def test_a_user_disabled_while_connected_is_dropped_at_the_next_heartbeat(
    driver, settings, fake_redis
):
    from asgiref.sync import sync_to_async

    settings.WS_HEARTBEAT_SECONDS = 0.2
    settings.WS_IDLE_TIMEOUT_SECONDS = 30
    comm = await open_socket(driver)
    await sync_to_async(type(driver).objects.filter(pk=driver.pk).update)(is_active=False)
    while True:
        event = await comm.receive_output(2)
        if event["type"] == "websocket.close":
            assert event["code"] == 4401
            break


async def test_auth_helper_still_reachable(driver, fake_redis):
    comm = new_communicator()
    assert (await comm.connect())[0]
    await comm.disconnect()
