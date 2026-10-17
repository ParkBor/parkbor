"""Edge paths of the gate code: lost races, vanished rows, odd tokens, permission classes."""

import logging
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError

from apps.bookings import checkin, checkout, operations, overstay, qr, reassign, walkin
from apps.bookings.conf import get_config
from apps.bookings.gate_errors import PlateBusy, SlotOccupied
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError
from apps.parking import access
from apps.parking.models import Slot, SlotStatus
from tests.bookings.factories import make_booking, make_vehicle, pg_integrity_error
from tests.helpers import make_user
from tests.operators.helpers import book, entry_token

pytestmark = pytest.mark.django_db


def code_of(exc_info) -> str:
    return str(exc_info.value.detail["code"])


# --- tokens -----------------------------------------------------------------------------------


def test_token_with_an_unknown_purpose_is_invalid(gate):
    booking = book(gate)
    forged = qr.signing.dumps(
        {
            "b": str(booking.pk),
            "l": str(gate.lot.pk),
            "n": booking.qr_nonce,
            "nb": int((gate.now - timedelta(hours=1)).timestamp()),
            "e": int((gate.now + timedelta(hours=1)).timestamp()),
            "p": "admin",
        },
        key=qr._key(),
        salt=qr.SALT,
        compress=True,
    )

    with pytest.raises(qr.QrInvalid):
        qr.verify_token(forged, now=gate.now)


def test_pre_step_9_tokens_still_verify_as_entry(gate):
    booking = book(gate)

    claims = qr.verify_token(entry_token(booking), now=gate.now)

    assert claims.purpose == qr.PURPOSE_ENTRY


def test_exit_token_for_a_booking_that_does_not_exist_is_invalid(gate):
    ghost = qr.signing.dumps(
        {
            "b": str(uuid.uuid4()),
            "l": str(gate.lot.pk),
            "n": "n" * 22,
            "nb": int((gate.now - timedelta(hours=1)).timestamp()),
            "e": int((gate.now + timedelta(hours=1)).timestamp()),
            "p": "exit",
        },
        key=qr._key(),
        salt=qr.SALT,
        compress=True,
    )

    with pytest.raises(ApiError) as exc:
        checkout.check_out(operator=gate.operator, token=ghost, now=gate.now)

    assert code_of(exc) == "qr_invalid"


# --- rows that vanish between the cheap check and the lock -------------------------------------


def test_booking_deleted_after_the_pre_check_is_invalid_not_a_crash(gate, monkeypatch):
    booking = book(gate)
    token = entry_token(booking)

    def gone(_booking_id):
        raise ObjectDoesNotExist

    monkeypatch.setattr(checkin.services, "lock_booking_row", gone)

    with pytest.raises(ApiError) as exc:
        checkin.check_in(operator=gate.operator, token=token, now=gate.now)

    assert code_of(exc) == "qr_invalid"


def test_checkout_booking_deleted_after_the_pre_check(gate, monkeypatch):
    booking = book(gate, status=S.ACTIVE, checked_in_at=gate.now)

    def gone(_booking_id):
        raise ObjectDoesNotExist

    monkeypatch.setattr(checkout.services, "lock_booking_row", gone)

    with pytest.raises(ApiError) as exc:
        checkout.check_out(
            operator=gate.operator,
            booking_id=booking.pk,
            plate_number=booking.vehicle_plate,
            now=gate.now,
        )

    assert code_of(exc) == "booking_not_found"


# --- walk-in: the database has the last word ---------------------------------------------------


@pytest.mark.parametrize(
    ("constraint", "expected"),
    [("booking_no_overlap", SlotOccupied), ("booking_vehicle_no_overlap", PlateBusy)],
)
def test_walk_in_translates_exclusion_violations(gate, monkeypatch, constraint, expected):
    def refuse(self, *args, **kwargs):
        raise pg_integrity_error(constraint)

    monkeypatch.setattr(Booking, "save", refuse)

    with pytest.raises(expected):
        walkin.register_walk_in(
            operator=gate.operator,
            slot_id=gate.slot.pk,
            plate_number="01A777BC",
            vehicle_type="CAR",
            now=gate.now,
        )

    assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.FREE


def test_walk_in_never_hides_other_integrity_errors(gate, monkeypatch):
    def refuse(self, *args, **kwargs):
        raise IntegrityError("something else")

    monkeypatch.setattr(Booking, "save", refuse)

    with pytest.raises(IntegrityError):
        walkin.register_walk_in(
            operator=gate.operator,
            slot_id=gate.slot.pk,
            plate_number="01A777BC",
            vehicle_type="CAR",
            now=gate.now,
        )


def test_walk_in_with_no_minimum_gap_and_a_booking_this_very_second(gate, settings):
    settings.BOOKING_WALKIN_MIN_GAP_MINUTES = 0
    book(gate, start_min=0, end_min=60)  # starts exactly now: the walk-in would be zero long

    with pytest.raises(ApiError) as exc:
        walkin.register_walk_in(
            operator=gate.operator,
            slot_id=gate.slot.pk,
            plate_number="01A777BC",
            vehicle_type="CAR",
            now=gate.now,
        )

    assert code_of(exc) == "slot_reserved_soon"


# --- reassign: robustness ----------------------------------------------------------------------


def _overstayer_and_waiting(gate):
    book(
        gate,
        status=S.OVERSTAY,
        start_min=-125,
        end_min=-5,
        checked_in_at=gate.now - timedelta(minutes=125),
    )
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)
    return book(
        gate,
        user=gate.owner,
        vehicle=make_vehicle(gate.owner),
        start_min=10,
        end_min=70,
    )


def test_one_failing_booking_does_not_stop_the_sweep(gate, monkeypatch, caplog):
    _overstayer_and_waiting(gate)

    def boom(*_args, **_kwargs):
        raise RuntimeError("poison")

    monkeypatch.setattr(reassign, "_reassign_one", boom)

    with caplog.at_level(logging.ERROR):
        assert reassign.resolve_overstay_conflicts(now=gate.now) == 0

    assert "reassigning failed" in caplog.text


def test_lost_exclusion_race_leaves_the_booking_where_it_is(gate, monkeypatch):
    waiting = _overstayer_and_waiting(gate)
    real_save = Booking.save

    def lose(self, *args, **kwargs):
        if kwargs.get("update_fields") and "slot" in kwargs["update_fields"]:
            raise pg_integrity_error("booking_no_overlap")
        return real_save(self, *args, **kwargs)

    monkeypatch.setattr(Booking, "save", lose)

    assert reassign.resolve_overstay_conflicts(now=gate.now) == 0

    assert Booking.objects.get(pk=waiting.pk).slot_id == gate.slot.pk


def test_reassign_ignores_a_booking_that_no_longer_exists(gate):
    assert reassign._reassign_one(uuid.uuid4(), gate.now) is False


def test_reassign_rechecks_under_the_lock(gate):
    waiting = _overstayer_and_waiting(gate)
    Booking.objects.filter(status=S.OVERSTAY).update(slot=gate.slots[1])  # nobody blocks it now

    assert reassign._reassign_one(waiting.pk, gate.now) is False


# --- money edges -------------------------------------------------------------------------------


def test_occupancy_of_a_lot_without_working_slots_is_zero(gate):
    Slot.objects.filter(zone__parking_lot=gate.lot).update(status=SlotStatus.OUT_OF_SERVICE)

    assert overstay.occupancy_now(gate.lot.pk, gate.slot, gate.now, get_config()) == 0


@pytest.mark.parametrize(
    ("seconds", "minutes"), [(-30, 0), (0, 0), (1, 1), (60, 1), (61, 2), (900, 15), (901, 16)]
)
def test_started_minutes_counts_a_started_minute_as_whole(gate, seconds, minutes):
    start = gate.now

    assert overstay.started_minutes(start, start + timedelta(seconds=seconds)) == minutes


# --- audit / errors ----------------------------------------------------------------------------


def test_error_code_of_an_odd_exception_falls_back():
    error = ApiError("x", "y")
    error.detail = "plain string"

    assert operations.error_code(error) == operations.SCAN_OUTCOME_UNKNOWN


# --- permission class --------------------------------------------------------------------------


def _request(user):
    return SimpleNamespace(user=user)


def test_is_operator_of_lot_for_lots_slots_zones_and_bookings(gate):
    permission = access.IsOperatorOfLot()
    booking = book(gate)
    stranger = make_user("OPERATOR")
    objects = [gate.lot, gate.zone, gate.slot, booking]

    assert permission.has_permission(_request(gate.operator), None)
    assert not permission.has_permission(_request(gate.owner), None)  # other classes cover owners
    for obj in objects:
        assert permission.has_object_permission(_request(gate.operator), None, obj)
        assert not permission.has_object_permission(_request(stranger), None, obj)
    assert not permission.has_object_permission(_request(gate.operator), None, object())
    assert not permission.has_object_permission(_request(gate.owner), None, gate.lot)


def test_other_users_cannot_pass_through_other_users_bookings(gate):
    other = make_booking(
        user=gate.driver,
        slot=gate.slots[1],
        vehicle=make_vehicle(gate.driver),
        start=gate.now,
        end=gate.now + timedelta(hours=1),
        status=S.CONFIRMED,
    )
    permission = access.IsOperatorOfLot()

    assert permission.has_object_permission(_request(gate.operator), None, other)
