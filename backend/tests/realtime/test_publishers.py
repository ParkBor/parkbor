"""Publishers: what goes to which group, debounce, fail-open, and the after-commit wiring."""

import logging
import uuid
from datetime import timedelta
from unittest import mock

import pytest
import redis
from django.db import transaction
from django.utils import timezone

from apps.bookings import hooks, services
from apps.bookings.state import BookingStatus
from apps.core.geomath import geohash_encode
from apps.parking.models import LotStatus, ParkingLot
from apps.realtime import groups, publishers
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user

pytestmark = pytest.mark.django_db

PII = ("plate", "phone", "first_name", "01a", "telegram")


@pytest.fixture
def world():
    return make_world(slots=3)


@pytest.fixture
def no_debounce(monkeypatch):
    """Availability is sent immediately (the debounce itself has its own tests)."""
    monkeypatch.setattr(publishers, "_claim_send_window", lambda lot_id: True)


# --- availability -------------------------------------------------------------------------


def test_availability_goes_to_the_lot_and_the_geo_group(world, layer, no_debounce):
    ParkingLot.objects.filter(pk=world.lot.pk).update(free_slots=2)
    publishers.on_availability_changed(lot_id=world.lot.pk)

    geo = groups.geo_group(geohash_encode(41.31, 69.24, 5))
    assert [g for g, _ in layer.sent] == [groups.lot_group(world.lot.pk), geo]
    payload = layer.payloads()[0]
    assert payload["type"] == "availability"
    assert payload["lot_id"] == str(world.lot.pk)
    assert (payload["free_slots"], payload["total_slots"]) == (2, 3)
    assert payload["ts"].endswith("Z")
    assert set(payload) == {"type", "lot_id", "free_slots", "total_slots", "ts"}


def test_availability_is_read_from_the_database_not_a_cache(world, layer, no_debounce):
    publishers.on_availability_changed(lot_id=world.lot.pk)
    ParkingLot.objects.filter(pk=world.lot.pk).update(free_slots=0)
    publishers.on_availability_changed(lot_id=world.lot.pk)
    assert [p["free_slots"] for p in layer.payloads(groups.lot_group(world.lot.pk))] == [3, 0]


@pytest.mark.parametrize("status", [LotStatus.PENDING_REVIEW, LotStatus.SUSPENDED])
def test_a_lot_that_is_not_public_is_never_announced(world, layer, no_debounce, status):
    ParkingLot.objects.filter(pk=world.lot.pk).update(status=status)
    publishers.on_availability_changed(lot_id=world.lot.pk)
    assert layer.sent == []


def test_an_unknown_lot_is_ignored(layer, no_debounce):
    publishers.on_availability_changed(lot_id=uuid.uuid4())
    assert layer.sent == []


def test_a_channel_layer_failure_does_not_reach_the_caller(world, layer, no_debounce, caplog):
    layer.error = OSError("redis is down")
    with caplog.at_level(logging.ERROR, logger="apps.realtime.publishers"):
        publishers.on_availability_changed(lot_id=world.lot.pk)  # must not raise
    assert "channel layer" in caplog.text


def test_no_channel_layer_configured_is_not_an_error(world, monkeypatch, no_debounce):
    monkeypatch.setattr(publishers, "get_channel_layer", lambda: None)
    publishers.on_availability_changed(lot_id=world.lot.pk)


# --- debounce -----------------------------------------------------------------------------


@pytest.fixture
def flush_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(
        publishers.flush_availability,
        "apply_async",
        lambda args=None, countdown=None, **kw: calls.append((args, countdown)),
    )
    return calls


def test_a_burst_sends_once_now_and_schedules_one_trailing_flush(
    world, layer, fake_redis, flush_calls
):
    for _ in range(5):
        publishers.on_availability_changed(lot_id=world.lot.pk)
    assert len(layer.payloads(groups.lot_group(world.lot.pk))) == 1  # leading edge
    assert len(flush_calls) == 1  # trailing edge, scheduled once
    args, countdown = flush_calls[0]
    assert args == [str(world.lot.pk)]
    assert 0.2 <= countdown <= 1


def test_the_trailing_flush_sends_the_latest_state_and_reopens_the_window(
    world, layer, fake_redis, flush_calls
):
    publishers.on_availability_changed(lot_id=world.lot.pk)
    publishers.on_availability_changed(lot_id=world.lot.pk)
    ParkingLot.objects.filter(pk=world.lot.pk).update(free_slots=1)
    fake_redis.delete(f"rt:avail:last:{world.lot.pk}")  # the 200 ms window has passed

    publishers.flush_availability.run(str(world.lot.pk))

    last = layer.payloads(groups.lot_group(world.lot.pk))[-1]
    assert last["free_slots"] == 1
    # a change right after the flush is coalesced again and schedules a NEW flush
    publishers.on_availability_changed(lot_id=world.lot.pk)
    assert len(flush_calls) == 2


def test_different_lots_do_not_debounce_each_other(layer, fake_redis, flush_calls):
    a, b = make_world(slots=1), make_world(slots=1)
    publishers.on_availability_changed(lot_id=a.lot.pk)
    publishers.on_availability_changed(lot_id=b.lot.pk)
    assert len(layer.payloads(groups.lot_group(a.lot.pk))) == 1
    assert len(layer.payloads(groups.lot_group(b.lot.pk))) == 1


def test_redis_down_sends_immediately_every_time(world, layer, fake_redis, monkeypatch):
    def boom(*a, **k):
        raise redis.ConnectionError("down")

    monkeypatch.setattr(fake_redis, "set", boom)
    publishers.on_availability_changed(lot_id=world.lot.pk)
    publishers.on_availability_changed(lot_id=world.lot.pk)
    assert len(layer.payloads(groups.lot_group(world.lot.pk))) == 2


def test_failed_enqueue_falls_back_to_an_immediate_send(world, layer, fake_redis, monkeypatch):
    monkeypatch.setattr(
        publishers.flush_availability,
        "apply_async",
        mock.Mock(side_effect=OSError("broker down")),
    )
    publishers.on_availability_changed(lot_id=world.lot.pk)  # leading
    publishers.on_availability_changed(lot_id=world.lot.pk)  # coalesced -> enqueue fails -> sent
    assert len(layer.payloads(groups.lot_group(world.lot.pk))) == 2
    # and the pending flag was released so the next burst can schedule again
    assert not fake_redis.exists(f"rt:avail:trail:{world.lot.pk}")


# --- booking_status / slot_status ---------------------------------------------------------


def test_booking_status_goes_only_to_the_owners_group(layer):
    user_id, booking_id = uuid.uuid4(), uuid.uuid4()
    publishers.on_booking_status(
        booking_id=booking_id,
        user_id=user_id,
        lot_id=uuid.uuid4(),
        status="CONFIRMED",
        previous="PENDING_PAYMENT",
    )
    assert [g for g, _ in layer.sent] == [groups.user_group(user_id)]
    assert layer.payloads()[0] == {
        "type": "booking_status",
        "booking_id": str(booking_id),
        "status": "CONFIRMED",
    }


def test_a_walk_in_has_no_user_group(layer):
    publishers.on_booking_status(
        booking_id=uuid.uuid4(),
        user_id=None,
        lot_id=uuid.uuid4(),
        status="ACTIVE",
        previous="CONFIRMED",
    )
    assert layer.sent == []


def test_slot_status_goes_to_the_operator_group_only(layer):
    lot_id, slot_id = uuid.uuid4(), uuid.uuid4()
    publishers.on_slot_status(lot_id=lot_id, slot_id=slot_id, status="OCCUPIED")
    assert [g for g, _ in layer.sent] == [groups.operator_group(lot_id)]
    assert layer.payloads()[0] == {
        "type": "slot_status",
        "lot_id": str(lot_id),
        "slot_id": str(slot_id),
        "status": "OCCUPIED",
    }


def test_reassignment_refreshes_both_slots_on_the_operator_map(world, layer):
    old, new = world.slots[0], world.slots[1]
    publishers.on_slot_reassigned(
        booking_id=uuid.uuid4(), old_slot_id=old.pk, new_slot_id=new.pk, lot_id=world.lot.pk
    )
    sent = layer.payloads(groups.operator_group(world.lot.pk))
    assert {p["slot_id"] for p in sent} == {str(old.pk), str(new.pk)}


def test_no_message_carries_personal_data(world, layer, no_debounce):
    publishers.on_availability_changed(lot_id=world.lot.pk)
    publishers.on_booking_status(
        booking_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        lot_id=world.lot.pk,
        status="ACTIVE",
        previous="CONFIRMED",
    )
    publishers.on_slot_status(lot_id=world.lot.pk, slot_id=world.slots[0].pk, status="FREE")
    text = repr(layer.sent).lower()
    assert not any(word in text for word in PII)


# --- wiring: after commit only ---------------------------------------------------------------


def test_slot_change_is_announced_after_commit(
    world, layer, no_debounce, django_capture_on_commit_callbacks
):
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        services.sync_slot_status(world.slots[0].pk, "OCCUPIED")
    assert layer.sent == []  # nothing yet: the transaction has not committed
    for callback in callbacks:
        callback()
    assert {p["type"] for p in layer.payloads()} == {"availability", "slot_status"}


def test_a_rolled_back_change_is_never_announced(
    world, layer, no_debounce, django_capture_on_commit_callbacks
):
    with django_capture_on_commit_callbacks(execute=True):
        try:
            with transaction.atomic():
                services.sync_slot_status(world.slots[0].pk, "OCCUPIED")
                raise RuntimeError("rollback")
        except RuntimeError:
            pass
    assert layer.sent == []


def test_a_booking_transition_reaches_its_driver(
    world, layer, no_debounce, django_capture_on_commit_callbacks
):
    driver = make_user("DRIVER")
    now = timezone.now().replace(second=0, microsecond=0)
    booking = make_booking(
        user=driver,
        slot=world.slots[0],
        vehicle=make_vehicle(driver),
        start=now + timedelta(hours=3),
        end=now + timedelta(hours=4),
        status=BookingStatus.CONFIRMED,
    )
    with django_capture_on_commit_callbacks(execute=True):
        services.cancel_booking(booking_id=booking.pk, user=driver)
    own = layer.payloads(groups.user_group(driver.pk))
    assert own == [{"type": "booking_status", "booking_id": str(booking.pk), "status": "CANCELLED"}]


def test_listener_registration_is_idempotent():
    from apps.core import events
    from apps.realtime.apps import register_listeners

    before = {name: list(items) for name, items in events._listeners.items()}
    register_listeners()
    register_listeners()
    assert {name: list(items) for name, items in events._listeners.items()} == before
    assert hooks.publish_availability_changed  # the public hook name is unchanged
