"""Overstay (10.7): hooks for the notification step and moving the next booking to a free slot."""

from datetime import timedelta

import pytest

from apps.bookings import checkin, hooks, reassign, services, tasks
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.parking.models import Slot, SlotStatus
from tests.bookings.factories import make_vehicle
from tests.operators.helpers import book, entry_token

pytestmark = pytest.mark.django_db


@pytest.fixture
def calls(monkeypatch):
    recorded = {"detected": [], "moved": [], "conflict": []}
    monkeypatch.setattr(hooks, "overstay_detected", lambda *a: recorded["detected"].append(a))
    monkeypatch.setattr(hooks, "slot_reassigned", lambda *a: recorded["moved"].append(a))
    monkeypatch.setattr(hooks, "overstay_conflict", lambda *a: recorded["conflict"].append(a))
    return recorded


def overstayer(gate, **extra):
    """A car on slot 0 whose booking ended 5 minutes ago."""
    booking = book(
        gate,
        status=S.OVERSTAY,
        start_min=-125,
        end_min=-5,
        checked_in_at=gate.now - timedelta(minutes=125),
        **extra,
    )
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)
    return booking


def waiting(gate, start_min, **extra):
    extra.setdefault("vehicle", make_vehicle(gate.owner))
    return book(gate, start_min=start_min, end_min=start_min + 60, user=gate.owner, **extra)


@pytest.fixture
def run(django_capture_on_commit_callbacks):
    """Run the sweep and fire its after-commit hooks (a test transaction never commits)."""

    def sweep(gate):
        with django_capture_on_commit_callbacks(execute=True):
            return reassign.resolve_overstay_conflicts(now=gate.now)

    return sweep


# --- hooks ------------------------------------------------------------------------------------


def test_detecting_an_overstay_calls_the_notification_hook_after_commit(
    gate, calls, django_capture_on_commit_callbacks
):
    booking = book(
        gate,
        status=S.ACTIVE,
        start_min=-120,
        end_min=-1,
        checked_in_at=gate.now - timedelta(hours=2),
    )

    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        assert services.detect_overstays(now=gate.now) == 1

    assert calls["detected"] == []  # nothing is announced before the commit
    for callback in callbacks:
        callback()
    assert calls["detected"] == [(booking.pk, gate.lot.pk, gate.driver.pk)]


def test_default_hooks_only_log_and_accept_a_walk_in_without_a_user(gate, caplog):
    with caplog.at_level("INFO", logger="apps.bookings.hooks"):
        assert hooks.overstay_detected(gate.slot.pk, gate.lot.pk, None) is None
        assert hooks.overstay_detected(gate.slot.pk, gate.lot.pk) is None
        assert hooks.slot_reassigned(gate.slot.pk, gate.slot.pk, gate.slot.pk, gate.lot.pk) is None
        assert hooks.overstay_conflict(gate.slot.pk, gate.lot.pk) is None
    assert "walk-in" in caplog.text


def test_a_walk_in_overstay_is_announced_without_a_driver(
    gate, calls, django_capture_on_commit_callbacks
):
    from apps.bookings import walkin

    parked = walkin.register_walk_in(
        operator=gate.operator,
        slot_id=gate.slot.pk,
        plate_number="01A777BC",
        vehicle_type="CAR",
        now=gate.now - timedelta(minutes=120),
    )
    Booking.objects.filter(pk=parked.pk).update()  # still ACTIVE
    book(gate, slot=gate.slot, start_min=300, end_min=360, vehicle=make_vehicle(gate.owner))

    with django_capture_on_commit_callbacks(execute=True):
        services.detect_overstays(now=gate.now + timedelta(hours=13))

    assert Booking.objects.get(pk=parked.pk).status == S.OVERSTAY
    assert calls["detected"] == [(parked.pk, gate.lot.pk, None)]


# --- moving the next booking ------------------------------------------------------------------


def test_next_booking_moves_to_a_free_slot_of_the_same_type(gate, calls, run):
    overstayer(gate)
    nxt = waiting(gate, start_min=10)

    assert run(gate) == 1

    nxt.refresh_from_db()
    assert nxt.slot_id == gate.slots[1].pk
    assert nxt.status == S.CONFIRMED
    event = BookingEvent.objects.get(booking=nxt, reason="slot_reassigned")
    assert event.actor_id is None
    assert event.meta == {"from": str(gate.slot.pk), "to": str(gate.slots[1].pk)}
    assert calls["moved"] == [(nxt.pk, gate.slot.pk, gate.slots[1].pk, gate.lot.pk)]
    assert calls["conflict"] == []


def test_a_booking_starting_later_than_the_window_stays_put(gate, calls, run):
    overstayer(gate)
    nxt = waiting(gate, start_min=16)

    assert run(gate) == 0

    assert Booking.objects.get(pk=nxt.pk).slot_id == gate.slot.pk
    assert calls["moved"] == [] and calls["conflict"] == []


def test_without_a_free_slot_the_conflict_hook_fires_and_nothing_moves(gate, calls, run):
    overstayer(gate)
    nxt = waiting(gate, start_min=5)
    book(
        gate,
        slot=gate.slots[1],
        user=gate.owner,
        vehicle=make_vehicle(gate.owner),
        start_min=0,
        end_min=90,
    )  # slot 1 is taken

    assert run(gate) == 0

    assert Booking.objects.get(pk=nxt.pk).slot_id == gate.slot.pk
    assert calls["conflict"] == [(nxt.pk, gate.lot.pk)]


def test_a_physically_occupied_slot_is_not_a_target_for_a_booking_starting_now(gate, calls, run):
    overstayer(gate)
    nxt = waiting(gate, start_min=5)
    Slot.objects.filter(pk=gate.slots[1].pk).update(status=SlotStatus.OCCUPIED)

    assert run(gate) == 0

    assert Booking.objects.get(pk=nxt.pk).slot_id == gate.slot.pk


def test_only_confirmed_bookings_are_moved(gate, calls, run):
    overstayer(gate)
    unpaid = waiting(
        gate,
        start_min=10,
        status=S.PENDING_PAYMENT,
        hold_expires_at=gate.now + timedelta(minutes=5),
    )

    assert run(gate) == 0

    assert Booking.objects.get(pk=unpaid.pk).slot_id == gate.slot.pk


def test_the_conflict_is_reported_once_not_every_minute(gate, calls, run):
    overstayer(gate)
    waiting(gate, start_min=5)
    book(
        gate,
        slot=gate.slots[1],
        user=gate.owner,
        vehicle=make_vehicle(gate.owner),
        start_min=0,
        end_min=90,
    )  # no free slot

    run(gate)
    run(gate)
    run(gate)

    assert len(calls["conflict"]) == 1
    assert BookingEvent.objects.filter(reason="overstay_conflict").count() == 1


def test_a_lapsed_unpaid_hold_does_not_make_a_slot_look_taken(gate, calls, run):
    overstayer(gate)
    nxt = waiting(gate, start_min=10)
    book(
        gate,
        slot=gate.slots[1],
        status=S.PENDING_PAYMENT,
        user=gate.owner,
        vehicle=make_vehicle(gate.owner),
        start_min=0,
        end_min=90,
        hold_expires_at=gate.now - timedelta(minutes=1),  # nobody paid in time
    )

    assert run(gate) == 1

    assert Booking.objects.get(pk=nxt.pk).slot_id == gate.slots[1].pk


def test_running_twice_changes_nothing_the_second_time(gate, calls, run):
    overstayer(gate)
    waiting(gate, start_min=10)
    run(gate)

    assert run(gate) == 0
    assert len(calls["moved"]) == 1


def test_no_overstayer_no_move(gate, calls, run):
    waiting(gate, start_min=10)

    assert run(gate) == 0


def test_reassigning_can_be_switched_off(gate, calls, settings, run):
    settings.BOOKING_OVERSTAY_REASSIGN_MINUTES = 0
    overstayer(gate)
    nxt = waiting(gate, start_min=10)

    assert run(gate) == 0

    assert Booking.objects.get(pk=nxt.pk).slot_id == gate.slot.pk


def test_moved_booking_checks_in_on_its_new_slot_with_the_same_qr(gate, calls, run):
    overstayer(gate)
    nxt = waiting(gate, start_min=10)
    token = entry_token(nxt)
    run(gate)

    result = checkin.check_in(
        operator=gate.operator, token=token, now=gate.now + timedelta(minutes=10)
    )

    assert result.code == "checked_in"
    assert Slot.objects.get(pk=gate.slots[1].pk).status == SlotStatus.OCCUPIED


def test_the_task_detects_then_moves(gate, calls):
    ending = book(
        gate,
        status=S.ACTIVE,
        start_min=-120,
        end_min=-1,
        checked_in_at=gate.now - timedelta(hours=2),
    )
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)
    nxt = waiting(gate, start_min=5)

    assert tasks.detect_overstays.run() == 1

    assert Booking.objects.get(pk=ending.pk).status == S.OVERSTAY
    assert Booking.objects.get(pk=nxt.pk).slot_id == gate.slots[1].pk
