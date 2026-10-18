"""Fail-closed heartbeat, guaranteed cleanup, max age, per-element rate charging, query counts."""

import pytest
from asgiref.sync import sync_to_async

from apps.parking.models import OperatorAssignment
from apps.realtime import consumers, queries, tickets
from apps.realtime.consumers import AvailabilityConsumer
from tests.bookings.factories import make_world
from tests.helpers import make_user
from tests.realtime.ws_helpers import drain, expect_close, new_communicator, open_socket, send

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


@pytest.fixture
def world():
    return make_world(slots=2)


@pytest.fixture
def driver():
    return make_user("DRIVER")


@pytest.fixture
def operator(world):
    user = make_user("OPERATOR")
    OperatorAssignment.objects.create(operator=user, parking_lot=world.lot, created_by=world.owner)
    return user


def fast_heartbeat(settings, interval=0.15):
    settings.WS_HEARTBEAT_SECONDS = interval
    settings.WS_IDLE_TIMEOUT_SECONDS = 60


# --- heartbeat fails closed -----------------------------------------------------------------


async def test_a_database_error_in_the_heartbeat_closes_with_1011(
    driver, settings, fake_redis, monkeypatch
):
    fast_heartbeat(settings)
    comm = await open_socket(driver)

    def broken(user_id):
        raise RuntimeError("database is gone")

    monkeypatch.setattr(queries, "user_is_active", broken)
    while True:  # pings may still be queued before the failing tick
        event = await comm.receive_output(2)
        if event["type"] == "websocket.close":
            assert event["code"] == 1011
            break


async def test_the_registry_is_cleaned_after_a_heartbeat_failure(
    driver, settings, fake_redis, monkeypatch
):
    fast_heartbeat(settings)
    comm = await open_socket(driver)
    assert fake_redis.zcard(f"ws:conns:{driver.pk}") == 1
    monkeypatch.setattr(queries, "user_is_active", lambda user_id: 1 / 0)
    await expect_close_eventually(comm, 1011)
    await comm.disconnect()
    assert fake_redis.zcard(f"ws:conns:{driver.pk}") == 0


async def expect_close_eventually(comm, code):
    while True:
        event = await comm.receive_output(2)
        if event["type"] == "websocket.close":
            assert event["code"] == code
            return


async def test_a_channel_layer_error_in_the_heartbeat_also_closes(
    world, operator, settings, fake_redis, monkeypatch
):
    fast_heartbeat(settings)
    comm = await open_socket(operator)
    await send(comm, type="subscribe", groups=[{"kind": "operator_lot", "id": str(world.lot.pk)}])
    await comm.receive_json_from()

    def broken(user_id, lot_ids):
        raise OSError("redis down")

    monkeypatch.setattr(queries, "operable_lot_ids", broken)
    await expect_close_eventually(comm, 1011)


async def test_revalidation_survives_an_unsubscribe_that_races_it(world, operator):
    """The group is removed while the permission query runs: no KeyError, no stray message."""
    consumer = AvailabilityConsumer()
    consumer.user_id = str(operator.pk)
    name = f"operator_lot_{world.lot.pk}"
    consumer.joined = {name: ("operator_lot", str(world.lot.pk))}
    sent, discarded = [], []

    class Layer:
        async def group_discard(self, group, channel):
            discarded.append(group)

    consumer.channel_layer, consumer.channel_name = Layer(), "ch"

    async def fake_send(payload):
        sent.append(payload)

    consumer._send = fake_send
    original = queries.operable_lot_ids

    def racing(user_id, lot_ids):
        consumer.joined.clear()  # the client unsubscribed meanwhile
        return original(user_id, [])[0], set()  # and the permission is gone

    queries.operable_lot_ids = racing
    try:
        assert await consumer._revalidate() is True
    finally:
        queries.operable_lot_ids = original
    assert sent == [] and discarded == []


# --- cleanup on crash --------------------------------------------------------------------------


async def test_a_crash_in_a_handler_still_releases_everything(
    world, driver, fake_redis, monkeypatch
):
    comm = await open_socket(driver)
    await send(comm, type="subscribe", groups=[{"kind": "lot", "id": str(world.lot.pk)}])
    await comm.receive_json_from()
    await drain(comm)
    from channels.layers import get_channel_layer

    layer = get_channel_layer()
    assert any(layer.groups.values())

    async def crash(self, message):
        raise RuntimeError("bug in a handler")

    monkeypatch.setattr(AvailabilityConsumer, "_ping", crash)
    await send(comm, type="ping")
    with pytest.raises(RuntimeError):
        await comm.wait()
    assert fake_redis.zcard(f"ws:conns:{driver.pk}") == 0
    assert not any(layer.groups.values())  # lot, area and personal groups are all gone


async def test_a_crash_in_an_event_handler_still_releases_everything(
    driver, fake_redis, monkeypatch
):
    from asgiref.sync import sync_to_async as to_async

    from apps.realtime import publishers

    comm = await open_socket(driver)

    async def crash(self, event):
        raise RuntimeError("bug in a layer event")

    monkeypatch.setattr(AvailabilityConsumer, "realtime_event", crash)
    await to_async(publishers.on_booking_status)(
        booking_id=driver.pk, user_id=driver.pk, lot_id=driver.pk, status="CONFIRMED", previous="x"
    )
    with pytest.raises(RuntimeError):
        await comm.wait()
    assert fake_redis.zcard(f"ws:conns:{driver.pk}") == 0


async def test_cleanup_is_idempotent_and_cancels_the_heartbeat(driver, fake_redis):
    comm = await open_socket(driver)
    await comm.disconnect()
    assert fake_redis.zcard(f"ws:conns:{driver.pk}") == 0


# --- max age -----------------------------------------------------------------------------------


async def test_a_connection_is_closed_4410_at_its_maximum_age(driver, settings, fake_redis):
    fast_heartbeat(settings, 0.1)
    settings.WS_MAX_AGE_SECONDS = 0.25
    comm = await open_socket(driver)
    await expect_close_eventually(comm, 4410)


# --- cost accounting -------------------------------------------------------------------------


async def test_a_subscribe_naming_many_groups_costs_per_group(driver, settings, fake_redis):
    settings.WS_MESSAGES_PER_SECOND = 10
    comm = await open_socket(driver)
    cells = [{"kind": "geo", "id": f"u000{c}"} for c in "0123456789"]
    await send(comm, type="subscribe", groups=cells)  # 10 elements: the whole bucket
    assert (await comm.receive_json_from())["type"] == "subscribed"
    await send(comm, type="subscribe", groups=cells)  # immediately again: not affordable
    await expect_close(comm, 4429)


async def test_pings_are_cheap(driver, settings, fake_redis):
    settings.WS_MESSAGES_PER_SECOND = 10
    comm = await open_socket(driver)
    for _ in range(9):
        await send(comm, type="ping")
    for _ in range(9):
        assert (await comm.receive_json_from())["type"] == "pong"
    await comm.disconnect()


# --- database load -----------------------------------------------------------------------------


@pytest.fixture
def count_calls(monkeypatch):
    calls = {"lots": [], "operator": []}
    real_lots, real_operator = queries.lots_snapshot, queries.operable_lot_ids

    def lots(ids):
        ids = list(ids)
        calls["lots"].append(len(ids))
        return real_lots(ids)

    def operator(user_id, ids):
        ids = list(ids)
        calls["operator"].append(len(ids))
        return real_operator(user_id, ids)

    monkeypatch.setattr(queries, "lots_snapshot", lots)
    monkeypatch.setattr(queries, "operable_lot_ids", operator)
    return calls


async def test_many_lots_in_one_message_use_one_query(driver, fake_redis, count_calls):
    worlds = [await sync_to_async(make_world)(slots=1) for _ in range(5)]
    comm = await open_socket(driver)
    await send(
        comm,
        type="subscribe",
        groups=[{"kind": "lot", "id": str(w.lot.pk)} for w in worlds],
    )
    reply = await comm.receive_json_from()
    assert len(reply["groups"]) == 5
    assert count_calls["lots"] == [5]
    snapshots = [await comm.receive_json_from() for _ in range(5)]
    assert {s["type"] for s in snapshots} == {"availability"}
    await comm.disconnect()


async def test_many_operator_lots_in_one_message_use_one_permission_query(
    world, operator, fake_redis, count_calls
):
    other = await sync_to_async(make_world)(slots=1)
    comm = await open_socket(operator)
    await send(
        comm,
        type="subscribe",
        groups=[{"kind": "operator_lot", "id": str(x.lot.pk)} for x in (world, other)],
    )
    reply = await comm.receive_json_from()
    assert len(reply["groups"]) == 1 and len(reply["rejected"]) == 1
    assert count_calls["operator"] == [2]
    await comm.disconnect()


async def test_a_refused_id_is_not_looked_up_again_for_a_while(driver, fake_redis, count_calls):
    import uuid

    ghost = str(uuid.uuid4())
    comm = await open_socket(driver)
    for _ in range(3):
        await send(comm, type="subscribe", groups=[{"kind": "lot", "id": ghost}])
        reply = await comm.receive_json_from()
        assert reply["rejected"][0]["code"] == "not_found"
    assert count_calls["lots"] == [1]
    await comm.disconnect()


async def test_the_negative_cache_expires(driver, settings, fake_redis, count_calls):
    import asyncio
    import uuid

    settings.WS_NEGATIVE_CACHE_SECONDS = 0.1
    ghost = str(uuid.uuid4())
    comm = await open_socket(driver)
    await send(comm, type="subscribe", groups=[{"kind": "lot", "id": ghost}])
    await comm.receive_json_from()
    await asyncio.sleep(0.2)
    await send(comm, type="subscribe", groups=[{"kind": "lot", "id": ghost}])
    await comm.receive_json_from()
    assert count_calls["lots"] == [1, 1]
    await comm.disconnect()


async def test_the_negative_cache_is_bounded(driver, fake_redis, monkeypatch):
    monkeypatch.setattr(consumers, "MAX_DENIED_ENTRIES", 3)
    consumer = AvailabilityConsumer()
    for i in range(10):
        consumer._deny("lot", str(i))
    assert len(consumer.denied) <= 3


async def test_the_heartbeat_checks_an_ordinary_user_with_an_exists_query(
    driver, settings, fake_redis, count_calls, monkeypatch
):
    fast_heartbeat(settings)
    checked = []
    real = queries.user_is_active

    def spy(user_id):
        checked.append(user_id)
        return real(user_id)

    monkeypatch.setattr(queries, "user_is_active", spy)
    comm = await open_socket(driver)
    assert (await comm.receive_json_from(timeout=2))["type"] == "ping"
    assert checked  # and no operator lookup was needed
    assert count_calls["operator"] == []
    await comm.disconnect()


async def test_timestamps_have_milliseconds(world, driver, fake_redis):
    import re

    comm = await open_socket(driver)
    await send(comm, type="subscribe", groups=[{"kind": "lot", "id": str(world.lot.pk)}])
    await comm.receive_json_from()
    snapshot = await comm.receive_json_from()
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", snapshot["ts"])
    await comm.disconnect()


# --- regression: a full-size subscribe from a full bucket -----------------------------------------

ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz"


def cells(count):
    return [
        {"kind": "geo", "id": f"u00{ALPHABET[i // 32]}{ALPHABET[i % 32]}x"[:5]}
        for i in range(count)
    ]


async def test_fifty_groups_in_one_frame_pass_from_a_full_bucket(driver, settings, fake_redis):
    settings.WS_MESSAGES_PER_SECOND = 10
    comm = await open_socket(driver)
    await send(comm, type="subscribe", groups=cells(50))
    reply = await comm.receive_json_from()
    assert (len(reply["groups"]), reply["rejected"]) == (50, [])
    await comm.disconnect()


async def test_the_fifty_first_group_is_rejected_as_too_many(driver, settings, fake_redis):
    settings.WS_MESSAGES_PER_SECOND = 10
    comm = await open_socket(driver)
    await send(comm, type="subscribe", groups=cells(51))
    reply = await comm.receive_json_from()
    assert len(reply["groups"]) == 50
    assert [r["code"] for r in reply["rejected"]] == ["too_many_groups"]
    await comm.disconnect()


async def test_a_second_big_frame_right_after_the_first_is_rate_limited(
    driver, settings, fake_redis
):
    settings.WS_MESSAGES_PER_SECOND = 10
    comm = await open_socket(driver)
    await send(comm, type="subscribe", groups=cells(50))
    assert (await comm.receive_json_from())["type"] == "subscribed"
    await send(comm, type="unsubscribe", groups=cells(50))
    await expect_close(comm, 4429)


async def test_a_connection_chosen_as_its_own_victim_closes_itself(driver, fake_redis, monkeypatch):
    from apps.realtime import connections

    monkeypatch.setattr(connections, "register", lambda user_id, channel: [channel])
    comm = new_communicator(ticket=tickets.issue_ticket(str(driver.pk)))
    assert (await comm.connect())[0]
    await expect_close_eventually(comm, 4409)
