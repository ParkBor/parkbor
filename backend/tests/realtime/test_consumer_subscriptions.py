"""Subscriptions: who may join which group, validation, and what is delivered."""

import uuid

import pytest
from asgiref.sync import sync_to_async

from apps.parking.models import LotStatus, OperatorAssignment, ParkingLot
from apps.realtime import publishers
from tests.bookings.factories import make_world
from tests.helpers import make_user
from tests.realtime.ws_helpers import drain, open_socket, send

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


@pytest.fixture
def world():
    return make_world(slots=3)


@pytest.fixture
def driver():
    return make_user("DRIVER")


@pytest.fixture
def operator(world):
    user = make_user("OPERATOR")
    OperatorAssignment.objects.create(operator=user, parking_lot=world.lot, created_by=world.owner)
    return user


def lot_item(lot_id, kind="lot"):
    return {"kind": kind, "id": str(lot_id)}


async def subscribe(comm, *items):
    await send(comm, type="subscribe", groups=list(items))
    return await comm.receive_json_from()


# --- lot / geo ----------------------------------------------------------------------------


async def test_subscribing_to_an_active_lot_replies_and_sends_a_snapshot(world, driver, fake_redis):
    comm = await open_socket(driver)
    reply = await subscribe(comm, lot_item(world.lot.pk))
    assert reply == {"type": "subscribed", "groups": [lot_item(world.lot.pk)], "rejected": []}
    snapshot = await comm.receive_json_from()
    assert snapshot["type"] == "availability"
    assert (snapshot["free_slots"], snapshot["total_slots"]) == (3, 3)
    await comm.disconnect()


async def test_a_published_change_reaches_a_lot_subscriber(world, driver, fake_redis):
    comm = await open_socket(driver)
    await subscribe(comm, lot_item(world.lot.pk))
    await drain(comm)
    await sync_to_async(ParkingLot.objects.filter(pk=world.lot.pk).update, thread_sensitive=False)(
        free_slots=1
    )
    await sync_to_async(publishers.broadcast_availability)(world.lot.pk)
    message = await comm.receive_json_from()
    assert message["type"] == "availability" and message["free_slots"] == 1
    await comm.disconnect()


async def test_a_geo_subscriber_gets_the_lots_of_that_cell(world, driver, fake_redis):
    from apps.core.geomath import geohash_encode

    cell = geohash_encode(41.31, 69.24, 5)
    comm = await open_socket(driver)
    reply = await subscribe(comm, {"kind": "geo", "id": cell})
    assert reply["groups"] == [{"kind": "geo", "id": cell}]
    await sync_to_async(publishers.broadcast_availability)(world.lot.pk)
    assert (await comm.receive_json_from())["lot_id"] == str(world.lot.pk)
    await comm.disconnect()


async def test_other_cells_hear_nothing(world, driver, fake_redis):
    comm = await open_socket(driver)
    await subscribe(comm, {"kind": "geo", "id": "u0000"})
    await sync_to_async(publishers.broadcast_availability)(world.lot.pk)
    assert await comm.receive_nothing(timeout=0.2)
    await comm.disconnect()


@pytest.mark.parametrize("status", [LotStatus.PENDING_REVIEW, LotStatus.SUSPENDED])
async def test_a_lot_that_is_not_active_cannot_be_followed(world, driver, fake_redis, status):
    await sync_to_async(ParkingLot.objects.filter(pk=world.lot.pk).update)(status=status)
    comm = await open_socket(driver)
    reply = await subscribe(comm, lot_item(world.lot.pk))
    assert reply["groups"] == []
    assert reply["rejected"] == [{**lot_item(world.lot.pk), "code": "not_found"}]
    await comm.disconnect()


async def test_an_unknown_lot_looks_the_same_as_a_hidden_one(driver, fake_redis):
    comm = await open_socket(driver)
    reply = await subscribe(comm, lot_item(uuid.uuid4()))
    assert reply["rejected"][0]["code"] == "not_found"
    await comm.disconnect()


@pytest.mark.parametrize(
    "item",
    [
        {"kind": "geo", "id": "tv7d"},
        {"kind": "geo", "id": "tv7da"},
        {"kind": "geo", "id": "../../x"},
        {"kind": "lot", "id": "not-a-uuid"},
        {"kind": "lot", "id": 5},
        {"kind": "lot"},
    ],
)
async def test_malformed_ids_are_rejected(driver, fake_redis, item):
    comm = await open_socket(driver)
    reply = await subscribe(comm, item)
    assert reply["groups"] == []
    assert reply["rejected"][0]["code"] == "invalid_group"
    await comm.disconnect()


async def test_unknown_kinds_are_rejected_and_user_groups_cannot_be_requested(driver, fake_redis):
    comm = await open_socket(driver)
    other = await sync_to_async(make_user)("DRIVER")
    reply = await subscribe(
        comm,
        {"kind": "user", "id": str(other.pk)},
        {"kind": "everything", "id": "*"},
        {"kind": 7, "id": "x"},
        "not-a-dict",
    )
    assert reply["groups"] == []
    assert [r["code"] for r in reply["rejected"]] == ["invalid_kind"] * 4
    await comm.disconnect()


async def test_rejected_entries_never_echo_long_client_text(driver, fake_redis):
    comm = await open_socket(driver)
    reply = await subscribe(comm, {"kind": "lot", "id": "x" * 3000})
    assert len(str(reply)) < 400
    await comm.disconnect()


async def test_subscribing_twice_is_harmless(world, driver, fake_redis):
    comm = await open_socket(driver)
    await subscribe(comm, lot_item(world.lot.pk))
    await drain(comm)
    reply = await subscribe(comm, lot_item(world.lot.pk))
    assert reply["groups"] == [lot_item(world.lot.pk)]
    await comm.disconnect()


async def test_unsubscribe_stops_delivery(world, driver, fake_redis):
    comm = await open_socket(driver)
    await subscribe(comm, lot_item(world.lot.pk))
    await drain(comm)
    await send(comm, type="unsubscribe", groups=[lot_item(world.lot.pk)])
    assert (await comm.receive_json_from())["type"] == "unsubscribed"
    await sync_to_async(publishers.broadcast_availability)(world.lot.pk)
    assert await comm.receive_nothing(timeout=0.2)
    await comm.disconnect()


async def test_groups_must_be_a_list(driver, fake_redis):
    comm = await open_socket(driver)
    await send(comm, type="subscribe", groups="lot")
    reply = await comm.receive_json_from()
    assert reply == {"type": "error", "code": "invalid_groups"}
    await comm.disconnect()


# --- limits -------------------------------------------------------------------------------


async def test_the_group_cap_is_enforced_per_connection(driver, settings, fake_redis):
    settings.WS_MAX_GROUPS_PER_CONNECTION = 3
    comm = await open_socket(driver)
    cells = [{"kind": "geo", "id": f"u000{c}"} for c in "01234"]
    assert len((await subscribe(comm, *cells[:3]))["groups"]) == 3
    reply = await subscribe(comm, *cells[3:])
    assert reply["groups"] == []
    assert [r["code"] for r in reply["rejected"]] == ["too_many_groups"] * 2
    # unsubscribing frees room
    await send(comm, type="unsubscribe", groups=[cells[0]])
    await comm.receive_json_from()
    assert (await subscribe(comm, cells[3]))["groups"] == [cells[3]]
    await comm.disconnect()


async def test_a_frame_naming_more_groups_than_the_cap_is_rejected_element_by_element(
    driver, settings, fake_redis
):
    settings.WS_MAX_GROUPS_PER_CONNECTION = 3
    settings.WS_MESSAGES_PER_SECOND = 1000  # this test is about the cap, not the rate
    comm = await open_socket(driver)
    wanted = [{"kind": "geo", "id": f"u000{c}"} for c in "01234"]
    await send(comm, type="subscribe", groups=wanted)
    reply = await comm.receive_json_from()
    assert len(reply["groups"]) == 3
    assert [r["code"] for r in reply["rejected"]] == ["too_many_groups"] * 2
    await comm.disconnect()


# --- booking_status (user_<id>) ------------------------------------------------------------


async def test_booking_status_reaches_only_its_own_user(driver, fake_redis):
    other = await sync_to_async(make_user)("DRIVER")
    mine = await open_socket(driver)
    theirs = await open_socket(other)
    booking_id = uuid.uuid4()
    await sync_to_async(publishers.on_booking_status)(
        booking_id=booking_id,
        user_id=driver.pk,
        lot_id=uuid.uuid4(),
        status="CONFIRMED",
        previous="PENDING_PAYMENT",
    )
    assert await mine.receive_json_from() == {
        "type": "booking_status",
        "booking_id": str(booking_id),
        "status": "CONFIRMED",
    }
    assert await theirs.receive_nothing(timeout=0.2)
    await mine.disconnect()
    await theirs.disconnect()


async def test_a_client_cannot_join_another_users_group_by_any_route(driver, fake_redis):
    victim = await sync_to_async(make_user)("DRIVER")
    comm = await open_socket(driver)
    reply = await subscribe(comm, {"kind": "user", "id": str(victim.pk)})
    assert reply["groups"] == []
    await sync_to_async(publishers.on_booking_status)(
        booking_id=uuid.uuid4(),
        user_id=victim.pk,
        lot_id=uuid.uuid4(),
        status="CANCELLED",
        previous="CONFIRMED",
    )
    assert await comm.receive_nothing(timeout=0.2)
    await comm.disconnect()


# --- operator_lot_<id> ---------------------------------------------------------------------


async def test_an_assigned_operator_receives_slot_status(world, operator, fake_redis):
    comm = await open_socket(operator)
    reply = await subscribe(comm, lot_item(world.lot.pk, "operator_lot"))
    assert reply["groups"] == [lot_item(world.lot.pk, "operator_lot")]
    slot = world.slots[0]
    await sync_to_async(publishers.on_slot_status)(
        lot_id=world.lot.pk, slot_id=slot.pk, status="OCCUPIED"
    )
    assert await comm.receive_json_from() == {
        "type": "slot_status",
        "lot_id": str(world.lot.pk),
        "slot_id": str(slot.pk),
        "status": "OCCUPIED",
    }
    await comm.disconnect()


async def test_the_owner_may_follow_their_own_lot_feed(world, fake_redis):
    comm = await open_socket(world.owner)
    reply = await subscribe(comm, lot_item(world.lot.pk, "operator_lot"))
    assert len(reply["groups"]) == 1
    await comm.disconnect()


async def test_a_driver_cannot_follow_the_operator_feed(world, driver, fake_redis):
    comm = await open_socket(driver)
    reply = await subscribe(comm, lot_item(world.lot.pk, "operator_lot"))
    assert reply["groups"] == []
    assert reply["rejected"][0]["code"] == "not_found"
    await sync_to_async(publishers.on_slot_status)(
        lot_id=world.lot.pk, slot_id=world.slots[0].pk, status="OCCUPIED"
    )
    assert await comm.receive_nothing(timeout=0.2)
    await comm.disconnect()


async def test_an_operator_of_another_lot_is_refused(world, operator, fake_redis):
    other = await sync_to_async(make_world)(slots=1)
    comm = await open_socket(operator)
    reply = await subscribe(comm, lot_item(other.lot.pk, "operator_lot"))
    assert reply["groups"] == []
    assert reply["rejected"][0]["code"] == "not_found"
    await comm.disconnect()


async def test_a_revoked_assignment_is_refused_on_the_next_subscribe(world, operator, fake_redis):
    from django.utils import timezone

    await sync_to_async(OperatorAssignment.objects.filter(operator=operator).update)(
        revoked_at=timezone.now()
    )
    comm = await open_socket(operator)
    reply = await subscribe(comm, lot_item(world.lot.pk, "operator_lot"))
    assert reply["rejected"][0]["code"] == "not_found"
    await comm.disconnect()


async def test_revocation_while_connected_drops_the_feed_at_the_next_heartbeat(
    world, operator, settings, fake_redis
):
    from django.utils import timezone

    settings.WS_HEARTBEAT_SECONDS = 0.3
    settings.WS_IDLE_TIMEOUT_SECONDS = 30
    comm = await open_socket(operator)
    await subscribe(comm, lot_item(world.lot.pk, "operator_lot"))
    await sync_to_async(OperatorAssignment.objects.filter(operator=operator).update)(
        revoked_at=timezone.now()
    )
    seen = []
    for _ in range(6):
        message = await comm.receive_json_from(timeout=2)
        seen.append(message["type"])
        if message["type"] == "unsubscribed":
            assert message["groups"] == [lot_item(world.lot.pk, "operator_lot")]
            break
    assert "unsubscribed" in seen
    await sync_to_async(publishers.on_slot_status)(
        lot_id=world.lot.pk, slot_id=world.slots[0].pk, status="FREE"
    )
    later = []
    for _ in range(3):  # about one second of traffic: heartbeat pings only
        try:
            later.append((await comm.receive_json_from(timeout=0.4))["type"])
        except TimeoutError:
            break
    assert "slot_status" not in later  # only heartbeat pings may still arrive
    await comm.disconnect()
