"""Check-out and overstay charging (ARCHITECTURE 6.2, 6.3, 10.7, 10.8 Step 9)."""

import logging
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from django.db.models import QuerySet

from apps.accounts.models import User
from apps.bookings import checkout, qr, services
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError
from apps.parking.models import (
    LotStatus,
    OperatorAssignment,
    ParkingLot,
    Slot,
    SlotStatus,
)
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user
from tests.operators.helpers import book, entry_token, exit_token, make_gate

pytestmark = pytest.mark.django_db

TASHKENT = ZoneInfo("Asia/Tashkent")
BLOCK = Decimal("1500.00")  # 6000 per hour, 15 minute block


def code_of(exc_info) -> str:
    return str(exc_info.value.detail["code"])


def active(gate, *, end_min=60, start_min=-60, **extra):
    """An ACTIVE booking whose car is parked (slot OCCUPIED)."""
    booking = book(
        gate,
        status=S.ACTIVE,
        start_min=start_min,
        end_min=end_min,
        checked_in_at=gate.now + timedelta(minutes=start_min),
        **extra,
    )
    Slot.objects.filter(pk=booking.slot_id).update(status=SlotStatus.OCCUPIED)
    return booking


def leave(gate, booking, *, minutes_after_end=0, seconds=0, collect=False, **kwargs):
    """Check out with the driver's exit QR `minutes_after_end` after the booking end."""
    when = booking.ends_at + timedelta(minutes=minutes_after_end, seconds=seconds)
    return checkout.check_out(
        operator=kwargs.pop("operator", gate.operator),
        token=exit_token(booking, when),
        collect=collect,
        now=when,
        **kwargs,
    )


# --- plain check-out --------------------------------------------------------------------------


def test_check_out_completes_and_frees_the_slot(gate):
    booking = active(gate)

    result = leave(gate, booking, minutes_after_end=-10)

    booking.refresh_from_db()
    assert result.code == "completed"
    assert booking.status == S.COMPLETED
    assert booking.checked_out_at == booking.ends_at - timedelta(minutes=10)
    assert (booking.overstay_minutes, booking.overstay_amount) == (0, Decimal("0.00"))
    assert booking.overstay_status == "none"
    assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.FREE
    assert ParkingLot.objects.get(pk=gate.lot.pk).free_slots == 2
    assert result.actual_minutes == 110


def test_check_out_exactly_at_the_end_costs_nothing(gate):
    booking = active(gate)

    leave(gate, booking)

    booking.refresh_from_db()
    assert (booking.overstay_minutes, booking.overstay_status) == (0, "none")


def test_check_out_is_logged_with_the_operator_as_actor(gate):
    booking = active(gate)

    leave(gate, booking, minutes_after_end=-5)

    event = BookingEvent.objects.get(booking=booking, to_status=S.COMPLETED)
    assert (event.actor_id, event.from_status, event.reason) == (
        gate.operator.id,
        S.ACTIVE,
        "checked_out",
    )


def test_overstay_booking_completes_too_and_releases_the_slot(gate):
    booking = active(gate, start_min=-120, end_min=-20)
    services.detect_overstays(now=gate.now)
    assert Booking.objects.get(pk=booking.pk).status == S.OVERSTAY

    result = leave(gate, booking, minutes_after_end=20)

    booking.refresh_from_db()
    assert (result.code, booking.status) == ("completed", S.COMPLETED)
    assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.FREE


# --- overstay money ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("minutes", "seconds", "blocks"),
    [
        (0, 1, 1),  # a single second late is already one (15 minute) block: no free window
        (1, 0, 1),
        (14, 0, 1),
        (15, 0, 1),
        (15, 1, 2),
        (16, 0, 2),
        (30, 0, 2),
        (31, 0, 3),
        (240, 0, 16),
    ],
)
def test_overstay_is_billed_in_started_15_minute_blocks(gate, minutes, seconds, blocks):
    booking = active(gate)

    leave(gate, booking, minutes_after_end=minutes, seconds=seconds)

    booking.refresh_from_db()
    assert booking.overstay_amount == BLOCK * blocks
    assert booking.overstay_minutes == minutes + (1 if seconds else 0)
    assert booking.overstay_status == "due"


def test_overstay_never_touches_amount_or_paid_amount(gate):
    booking = active(gate, amount="12000", paid_amount="12000")

    leave(gate, booking, minutes_after_end=20)

    booking.refresh_from_db()
    assert (booking.amount, booking.paid_amount) == (Decimal("12000.00"), Decimal("12000.00"))


def test_overstay_across_a_night_coefficient_boundary(db):
    rules = {"coefficients": [{"from": "22:00", "to": "06:00", "coefficient": "1.5"}]}
    gate = make_gate(rules=rules)
    ends = datetime(2026, 10, 20, 21, 50, tzinfo=TASHKENT)
    booking = make_booking(
        user=gate.driver,
        slot=gate.slot,
        vehicle=gate.vehicle,
        start=ends - timedelta(hours=2),
        end=ends,
        status=S.ACTIVE,
        checked_in_at=ends - timedelta(hours=2),
    )

    when = ends + timedelta(minutes=30)  # blocks start 21:50 (x1) and 22:05 (x1.5)
    checkout.check_out(operator=gate.operator, token=exit_token(booking, when), now=when)

    booking.refresh_from_db()
    assert booking.overstay_amount == Decimal("3750.00")


def test_dynamic_coefficient_uses_the_occupancy_without_the_leaving_car(db):
    gate = make_gate(slots=10)
    for other in gate.slots[1:]:  # nine other cars: 90 % (the leaving car does not count)
        Slot.objects.filter(pk=other.pk).update(status=SlotStatus.OCCUPIED)
    booking = active(gate)

    leave(gate, booking, minutes_after_end=10)  # k = 1 + 0.5 * (0.9 - 0.8) = 1.05

    booking.refresh_from_db()
    assert booking.overstay_amount == Decimal("1575.00")


def test_a_full_lot_does_not_overcharge_the_car_that_is_leaving(db):
    gate = make_gate(slots=5)
    for other in gate.slots[1:]:  # all five busy, but only four WITHOUT the leaving car: 80 %
        Slot.objects.filter(pk=other.pk).update(status=SlotStatus.OCCUPIED)
    booking = active(gate)

    leave(gate, booking, minutes_after_end=10)

    booking.refresh_from_db()
    assert booking.overstay_amount == BLOCK  # not above the threshold: factor 1


def test_a_quiet_lot_charges_the_plain_tariff(db):
    gate = make_gate(slots=5)
    booking = active(gate)

    leave(gate, booking, minutes_after_end=10)  # only the overstayer's slot is busy: 20 %

    booking.refresh_from_db()
    assert booking.overstay_amount == BLOCK


def test_zero_priced_tariff_leaves_nothing_due(db):
    gate = make_gate(price="0")
    booking = active(gate)

    leave(gate, booking, minutes_after_end=30)

    booking.refresh_from_db()
    assert (booking.overstay_status, booking.overstay_amount) == ("none", Decimal("0.00"))
    assert booking.overstay_minutes == 30


# --- collecting the money ---------------------------------------------------------------------


def test_collect_true_marks_the_overstay_collected(gate):
    booking = active(gate)

    result = leave(gate, booking, minutes_after_end=20, collect=True)

    booking.refresh_from_db()
    assert booking.overstay_status == "collected"
    assert result.to_collect == Decimal("0.00")


def test_collect_false_leaves_it_due_and_reports_what_to_take(gate):
    booking = active(gate)

    result = leave(gate, booking, minutes_after_end=20, collect=False)

    booking.refresh_from_db()
    assert booking.overstay_status == "due"
    assert result.to_collect == BLOCK * 2


def test_collect_without_an_overstay_changes_nothing(gate):
    booking = active(gate)

    leave(gate, booking, minutes_after_end=-5, collect=True)

    assert Booking.objects.get(pk=booking.pk).overstay_status == "none"


# --- idempotent repeat ------------------------------------------------------------------------


def test_checking_out_twice_is_harmless(gate):
    booking = active(gate)
    leave(gate, booking, minutes_after_end=20)
    first = Booking.objects.get(pk=booking.pk)

    second = leave(gate, booking, minutes_after_end=45)

    after = Booking.objects.get(pk=booking.pk)
    assert second.code == "already_completed"
    assert (after.checked_out_at, after.overstay_amount) == (
        first.checked_out_at,
        first.overstay_amount,
    )
    assert BookingEvent.objects.filter(booking=booking, to_status=S.COMPLETED).count() == 1


def test_repeating_with_collect_settles_a_due_overstay_once(gate):
    booking = active(gate)
    leave(gate, booking, minutes_after_end=20)  # the operator sees the amount first ...

    settled = leave(gate, booking, minutes_after_end=22, collect=True)  # ... then takes the cash

    assert settled.code == "already_completed"
    assert settled.to_collect == Decimal("0.00")
    assert Booking.objects.get(pk=booking.pk).overstay_status == "collected"
    leave(gate, booking, minutes_after_end=25, collect=True)
    assert BookingEvent.objects.filter(booking=booking, reason="fee_collected").count() == 1


# --- statuses ---------------------------------------------------------------------------------


def test_confirmed_booking_that_never_entered_is_not_checked_in(gate):
    booking = book(gate)

    with pytest.raises(ApiError) as exc:
        leave(gate, booking)

    assert code_of(exc) == "not_checked_in"
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


@pytest.mark.parametrize("status", [S.PENDING_PAYMENT, S.CANCELLED, S.EXPIRED, S.NO_SHOW])
def test_dead_bookings_are_not_active(gate, status):
    booking = book(gate, status=status)

    with pytest.raises(ApiError) as exc:
        leave(gate, booking)

    assert code_of(exc) == "booking_not_active"


# --- manual path (booking id + plate) ---------------------------------------------------------


def walk_in_parked(gate, plate="01A777BC"):
    from apps.bookings import walkin

    return walkin.register_walk_in(
        operator=gate.operator,
        slot_id=gate.slot.pk,
        plate_number=plate,
        vehicle_type="CAR",
        now=gate.now - timedelta(minutes=30),
    )


def by_hand(gate, booking, plate=None, **kwargs):
    return checkout.check_out(
        operator=kwargs.pop("operator", gate.operator),
        booking_id=booking.pk,
        plate_number=plate if plate is not None else booking.vehicle_plate,
        now=kwargs.pop("now", gate.now),
        **kwargs,
    )


def test_an_online_booking_cannot_be_checked_out_by_plate_alone(gate):
    booking = active(gate)

    with pytest.raises(ApiError) as exc:
        by_hand(gate, booking)

    assert (exc.value.status_code, code_of(exc)) == (403, "exit_qr_required")
    assert Booking.objects.get(pk=booking.pk).status == S.ACTIVE


def test_even_an_owner_needs_override_and_a_note(gate):
    booking = active(gate)

    with pytest.raises(ApiError) as exc:
        by_hand(gate, booking, operator=gate.owner)
    with pytest.raises(ApiError) as exc2:
        by_hand(gate, booking, operator=gate.owner, override=True)  # no reason given
    with pytest.raises(ApiError) as exc3:
        by_hand(gate, booking, override=True, note="phone dead")  # an operator may not override

    assert [code_of(e) for e in (exc, exc2, exc3)] == ["exit_qr_required"] * 3


def test_owner_override_with_a_note_checks_an_online_booking_out_and_leaves_a_trail(
    gate, caplog, django_capture_on_commit_callbacks
):
    booking = active(gate, vehicle=make_vehicle(gate.driver, plate="01A123BC"))

    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        result = by_hand(
            gate,
            booking,
            plate=" 01 a-123 bc ",  # normalised before comparing
            operator=gate.owner,
            override=True,
            note="driver's phone is dead",
        )

    assert result.code == "completed"
    event = BookingEvent.objects.get(booking=booking, to_status=S.COMPLETED)
    assert event.meta["override_note"] == "driver's phone is dead"
    scan = next(r for r in caplog.records if r.getMessage() == "audit operator.checkout")
    assert scan.audit_after["override"] is True


def test_a_walk_in_leaves_by_plate(gate):
    parked = walk_in_parked(gate)

    result = by_hand(gate, parked)

    assert result.code == "completed"


def test_wrong_plate_is_refused_before_anything_about_the_booking_is_said(gate):
    booking = active(gate)

    with pytest.raises(ApiError) as exc:
        by_hand(gate, booking, plate="99Z999ZZ")

    assert code_of(exc) == "plate_mismatch"
    assert Booking.objects.get(pk=booking.pk).status == S.ACTIVE


def test_garbage_plate_is_a_mismatch(gate):
    booking = active(gate)

    with pytest.raises(ApiError) as exc:
        by_hand(gate, booking, plate="???")

    assert code_of(exc) == "plate_mismatch"


def test_booking_of_another_lot_is_not_found(gate):
    other = make_world(slots=1)
    stranger = make_user("DRIVER")
    booking = make_booking(
        user=stranger,
        slot=other.slots[0],
        vehicle=make_vehicle(stranger),
        start=gate.now - timedelta(hours=1),
        end=gate.now + timedelta(hours=1),
        status=S.ACTIVE,
    )

    with pytest.raises(ApiError) as exc:
        by_hand(gate, booking)

    assert (exc.value.status_code, code_of(exc)) == (404, "booking_not_found")
    assert Booking.objects.get(pk=booking.pk).status == S.ACTIVE


def test_unknown_booking_looks_the_same(gate):
    import uuid

    with pytest.raises(ApiError) as exc:
        checkout.check_out(
            operator=gate.operator, booking_id=uuid.uuid4(), plate_number="01A123BC", now=gate.now
        )

    assert (exc.value.status_code, code_of(exc)) == (404, "booking_not_found")


def test_owner_checks_out_in_their_own_lot(gate):
    booking = active(gate)

    assert leave(gate, booking, operator=gate.owner, minutes_after_end=-1).code == "completed"


def test_expected_lot_other_than_the_booking_lot_is_wrong_lot(gate):
    other = make_world(slots=1)
    OperatorAssignment.objects.create(operator=gate.operator, parking_lot=other.lot)
    booking = active(gate)

    with pytest.raises(ApiError) as exc:
        leave(gate, booking, expected_lot_id=other.lot.id)

    assert code_of(exc) == "wrong_lot"


def test_leaving_works_while_the_lot_is_suspended(gate):
    booking = active(gate)
    ParkingLot.objects.filter(pk=gate.lot.pk).update(status=LotStatus.SUSPENDED)
    operator = User.objects.get(pk=gate.operator.pk)

    result = leave(gate, booking, operator=operator, minutes_after_end=20, collect=True)

    assert result.code == "completed"
    assert Booking.objects.get(pk=booking.pk).overstay_status == "collected"


def test_leaving_works_while_the_lot_is_back_in_review(gate):
    booking = active(gate)
    ParkingLot.objects.filter(pk=gate.lot.pk).update(status=LotStatus.PENDING_REVIEW)

    assert leave(gate, booking, operator=gate.owner, minutes_after_end=-1).code == "completed"


def test_the_repeat_reports_the_real_parked_time_not_the_time_of_the_repeat(gate):
    booking = active(gate)
    first = leave(gate, booking, minutes_after_end=-10)

    again = leave(gate, booking, minutes_after_end=500)  # hours later

    assert again.code == "already_completed"
    assert again.actual_minutes == first.actual_minutes == 110


def test_a_replayed_exit_code_with_a_replaced_nonce_gets_no_answer_after_completion(gate):
    booking = active(gate)
    token = exit_token(booking, gate.now)
    qr_out(gate, token)
    services.rotate_qr_nonce(booking)  # any later code must not be recognised

    with pytest.raises(ApiError) as exc:
        qr_out(gate, token, when=gate.now + timedelta(minutes=1))

    assert code_of(exc) == "qr_outdated"


# --- QR path ----------------------------------------------------------------------------------


def qr_out(gate, token, *, when=None, **kwargs):
    return checkout.check_out(operator=gate.operator, token=token, now=when or gate.now, **kwargs)


def test_exit_qr_completes_the_booking_and_burns_its_nonce(gate):
    booking = active(gate)
    token = exit_token(booking, gate.now)

    result = qr_out(gate, token)

    booking.refresh_from_db()
    assert result.code == "completed"
    assert booking.status == S.COMPLETED
    assert booking.qr_nonce_used_at is not None


def test_exit_qr_scanned_again_is_already_completed(gate):
    booking = active(gate)
    token = exit_token(booking, gate.now)
    qr_out(gate, token)

    again = qr_out(gate, token, when=gate.now + timedelta(minutes=1))

    assert again.code == "already_completed"
    assert BookingEvent.objects.filter(booking=booking, to_status=S.COMPLETED).count() == 1


def test_entry_qr_is_refused_at_the_exit(gate):
    booking = active(gate)

    with pytest.raises(ApiError) as exc:
        qr_out(gate, entry_token(booking))

    assert code_of(exc) == "qr_wrong_purpose"


def test_replaced_exit_qr_is_outdated(gate):
    booking = active(gate)
    old = exit_token(booking, gate.now)
    services.rotate_qr_nonce(booking)

    with pytest.raises(ApiError) as exc:
        qr_out(gate, old)

    assert code_of(exc) == "qr_outdated"
    assert Booking.objects.get(pk=booking.pk).status == S.ACTIVE


def test_spent_exit_nonce_on_a_still_active_booking_is_already_used(gate):
    booking = active(gate)
    token = exit_token(booking, gate.now)
    Booking.objects.filter(pk=booking.pk).update(qr_nonce_used_at=gate.now)

    with pytest.raises(ApiError) as exc:
        qr_out(gate, token)

    assert code_of(exc) == "already_used"


def test_exit_qr_of_another_lot_is_wrong_lot(gate):
    other = make_world(slots=1)
    stranger = make_user("DRIVER")
    booking = make_booking(
        user=stranger,
        slot=other.slots[0],
        vehicle=make_vehicle(stranger),
        start=gate.now - timedelta(hours=1),
        end=gate.now + timedelta(hours=1),
        status=S.ACTIVE,
        checked_in_at=gate.now - timedelta(hours=1),
    )

    with pytest.raises(ApiError) as exc:
        qr_out(gate, exit_token(booking, gate.now))

    assert code_of(exc) == "wrong_lot"


def test_exit_qr_of_an_overstaying_driver_works_long_after_the_booking_ended(gate):
    booking = active(gate, start_min=-300, end_min=-240)
    asked_at = gate.now - timedelta(minutes=5)  # the driver opened the app a little earlier
    token = exit_token(booking, asked_at)

    result = qr_out(gate, token)

    assert result.code == "completed"
    assert Booking.objects.get(pk=booking.pk).overstay_amount > 0


def test_expired_exit_qr(gate, settings):
    booking = active(gate)
    token = exit_token(booking, gate.now - timedelta(minutes=settings.BOOKING_QR_EXIT_MINUTES + 5))

    with pytest.raises(ApiError) as exc:
        qr_out(gate, token)

    assert code_of(exc) == "qr_expired"


def test_exit_qr_issued_by_the_booking_endpoint_round_trips(gate):
    booking = active(gate)
    fresh = Booking.objects.select_related("slot__zone").get(pk=booking.pk)

    token, expires_at = qr.issue_exit_token(fresh, now=gate.now)

    claims = qr.verify_token(token, expected_purpose="exit", now=gate.now)
    assert claims.purpose == "exit"
    assert expires_at > gate.now + timedelta(hours=1)


# --- atomicity, locks, audit ------------------------------------------------------------------


def test_failure_while_releasing_the_slot_rolls_the_check_out_back(gate, monkeypatch):
    booking = active(gate)

    def boom(*args, **kwargs):
        raise RuntimeError("database went away")

    monkeypatch.setattr("apps.bookings.checkout.operations.set_slot_status_locked", boom)

    with pytest.raises(RuntimeError):
        qr_out(gate, exit_token(booking, gate.now))

    after = Booking.objects.get(pk=booking.pk)
    assert (after.status, after.checked_out_at, after.qr_nonce_used_at) == (S.ACTIVE, None, None)


def test_lock_order_is_lot_then_booking_then_slot(gate, monkeypatch):
    booking = active(gate)
    order = []
    original = QuerySet.select_for_update

    def spy(self, *args, **kwargs):
        order.append(self.model.__name__)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(QuerySet, "select_for_update", spy)

    leave(gate, booking)

    assert order[0] == "ParkingLot"
    assert order.index("Booking") < order.index("Slot")


def test_attempts_are_audited_without_the_token(gate, caplog, django_capture_on_commit_callbacks):
    booking = active(gate)
    token = exit_token(booking, gate.now)

    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        qr_out(gate, token)
        with pytest.raises(ApiError):
            qr_out(gate, "forged")

    scans = [r for r in caplog.records if r.getMessage() == "audit operator.checkout"]
    assert [r.audit_after["outcome"] for r in scans] == ["completed", "qr_invalid"]
    assert all(r.audit_actor == str(gate.operator.id) for r in scans)
    assert token not in " ".join(str(r.__dict__) for r in caplog.records)


# --- the price of an overstay is frozen, bounded and never silent ----------------------------


def test_the_tariff_at_booking_time_prices_the_overstay_not_todays(gate):
    from apps.parking.models import Tariff

    booking = active(
        gate,
        tariff_snapshot={"price_per_hour": "6000.00", "rules": {}},
    )
    Tariff.objects.filter(parking_lot=gate.lot).update(price_per_hour=Decimal("60000"))

    leave(gate, booking, minutes_after_end=10)

    assert Booking.objects.get(pk=booking.pk).overstay_amount == BLOCK  # 1500, not 15 000


def test_bookings_without_a_snapshot_use_the_current_tariff(gate):
    from apps.parking.models import Tariff

    booking = active(gate)  # a row from before snapshots existed
    Tariff.objects.filter(parking_lot=gate.lot).update(price_per_hour=Decimal("12000"))

    leave(gate, booking, minutes_after_end=10)

    assert Booking.objects.get(pk=booking.pk).overstay_amount == BLOCK * 2


def test_new_bookings_carry_a_tariff_snapshot(gate):
    from apps.bookings import services as booking_services

    driver = make_user("DRIVER")
    created = booking_services.create_booking(
        user=driver,
        lot_id=gate.lot.pk,
        slot_type="STANDARD",
        vehicle=make_vehicle(driver),
        start=gate.now + timedelta(hours=1),
        end=gate.now + timedelta(hours=2),
        now=gate.now,
    )

    assert Booking.objects.get(pk=created.pk).tariff_snapshot == {
        "price_per_hour": "6000.00",
        "rules": {},
    }


def test_a_missing_tariff_charges_nothing_but_leaves_a_trail(gate):
    from apps.audit.models import AuditLog
    from apps.parking.models import Tariff

    booking = active(gate)
    Tariff.objects.filter(parking_lot=gate.lot).delete()

    leave(gate, booking, minutes_after_end=40)

    booking = Booking.objects.get(pk=booking.pk)
    assert (booking.status, booking.overstay_amount, booking.overstay_status) == (
        S.COMPLETED,
        Decimal("0.00"),
        "none",
    )
    assert booking.overstay_minutes == 40
    assert BookingEvent.objects.filter(booking=booking, reason="overstay_no_tariff").count() == 1
    assert AuditLog.objects.filter(action="booking.overstay_no_tariff").count() == 1


def test_a_forgotten_car_is_billed_for_at_most_the_maximum_and_flagged(gate, settings):
    settings.BOOKING_OVERSTAY_MAX_DAYS = 2
    booking = active(gate)

    leave(gate, booking, minutes_after_end=60 * 24 * 40)  # 40 days late

    booking = Booking.objects.get(pk=booking.pk)
    assert booking.status == S.COMPLETED  # the car is not trapped
    assert booking.overstay_minutes == 60 * 24 * 40  # the truth is recorded ...
    assert booking.overstay_amount == BLOCK * 4 * 24 * 2  # ... the bill stops at 2 days
    assert booking.overstay_status == "due"  # never auto-"collected" for a capped charge
    assert BookingEvent.objects.filter(booking=booking, reason="overstay_needs_review").exists()


def test_a_capped_charge_stays_due_even_if_the_operator_says_collected(gate, settings):
    settings.BOOKING_OVERSTAY_MAX_DAYS = 1
    booking = active(gate)

    leave(gate, booking, minutes_after_end=60 * 24 * 5, collect=True)

    assert Booking.objects.get(pk=booking.pk).overstay_status == "due"


def test_an_absurd_tariff_cannot_overflow_the_money_column(gate):
    booking = active(
        gate,
        tariff_snapshot={"price_per_hour": "9999999999.99", "rules": {}},
    )

    leave(gate, booking, minutes_after_end=60 * 24 * 20)

    booking = Booking.objects.get(pk=booking.pk)
    assert booking.status == S.COMPLETED
    assert booking.overstay_amount == Decimal("9999999999.99")
    assert booking.overstay_status == "due"
    assert BookingEvent.objects.filter(booking=booking, reason="overstay_needs_review").exists()


def test_a_quote_never_loops_over_an_unbounded_number_of_blocks():
    from apps.bookings.pricing import calc_price

    start = datetime(2026, 1, 1, tzinfo=TASHKENT)

    with pytest.raises(ValueError):
        calc_price(
            price_per_hour=Decimal("1"),
            rules={},
            start=start,
            end=start + timedelta(days=5000),
        )


def test_a_capped_walk_in_is_never_marked_paid_on_the_word_of_the_operator(gate, settings):
    settings.BOOKING_OVERSTAY_MAX_DAYS = 1
    from apps.bookings import walkin

    parked = walkin.register_walk_in(
        operator=gate.operator,
        slot_id=gate.slot.pk,
        plate_number="01A777BC",
        vehicle_type="CAR",
        now=gate.now,
    )

    checkout.check_out(
        operator=gate.operator,
        booking_id=parked.pk,
        plate_number="01A777BC",
        collect=True,
        now=gate.now + timedelta(days=9),
    )

    parked = Booking.objects.get(pk=parked.pk)
    assert parked.amount == Decimal("144000.00")  # one day: 10 minutes free, then 96 blocks
    assert parked.paid_amount == 0
    assert BookingEvent.objects.filter(booking=parked, reason="overstay_needs_review").exists()


# --- reviewed charges, damaged tariff data, plate on the QR path (final round) --------------------


def capped_overstay(gate, settings):
    settings.BOOKING_OVERSTAY_MAX_DAYS = 1
    booking = active(gate)
    token = exit_token(booking, booking.ends_at + timedelta(days=5))
    checkout.check_out(operator=gate.operator, token=token, now=booking.ends_at + timedelta(days=5))
    return Booking.objects.get(pk=booking.pk), token


def test_a_capped_charge_is_flagged_on_the_booking_itself(gate, settings):
    booking, _token = capped_overstay(gate, settings)

    assert booking.overstay_needs_review is True
    assert booking.overstay_status == "due"


def test_an_ordinary_charge_is_not_flagged(gate):
    booking = active(gate)

    leave(gate, booking, minutes_after_end=20)

    assert Booking.objects.get(pk=booking.pk).overstay_needs_review is False


def test_the_operator_cannot_settle_a_flagged_charge_by_repeating_with_collect(gate, settings):
    booking, token = capped_overstay(gate, settings)
    later = booking.checked_out_at + timedelta(minutes=1)

    with pytest.raises(ApiError) as exc:
        checkout.check_out(operator=gate.operator, token=token, collect=True, now=later)

    assert (exc.value.status_code, code_of(exc)) == (409, "needs_review")
    again = Booking.objects.get(pk=booking.pk)
    assert (again.overstay_status, again.overstay_needs_review) == ("due", True)


def test_an_owner_settles_a_flagged_charge_only_with_override_and_a_note(gate, settings):
    from apps.audit.models import AuditLog

    booking, _token = capped_overstay(gate, settings)
    later = booking.checked_out_at + timedelta(minutes=1)
    by_hand = {"booking_id": booking.pk, "plate_number": booking.vehicle_plate, "now": later}

    with pytest.raises(ApiError):  # no override: an owner is not enough on its own
        checkout.check_out(operator=gate.owner, collect=True, **by_hand)
    result = checkout.check_out(
        operator=gate.owner, collect=True, override=True, note="cash counted, 2 days", **by_hand
    )

    booking.refresh_from_db()
    assert result.code == "already_completed"
    assert (booking.overstay_status, booking.overstay_needs_review) == ("collected", False)
    event = BookingEvent.objects.get(booking=booking, reason="fee_collected")
    assert event.meta["override_note"] == "cash counted, 2 days"
    assert AuditLog.objects.filter(action="booking.fee_collected", actor=gate.owner).exists()


def test_a_flagged_walk_in_is_settled_the_same_way(gate, settings):
    from apps.bookings import walkin

    settings.BOOKING_OVERSTAY_MAX_DAYS = 1
    parked = walkin.register_walk_in(
        operator=gate.operator,
        slot_id=gate.slot.pk,
        plate_number="01A777BC",
        vehicle_type="CAR",
        now=gate.now,
    )
    out = gate.now + timedelta(days=9)
    checkout.check_out(
        operator=gate.operator, booking_id=parked.pk, plate_number="01A777BC", now=out
    )

    with pytest.raises(ApiError) as exc:
        checkout.check_out(
            operator=gate.operator,
            booking_id=parked.pk,
            plate_number="01A777BC",
            collect=True,
            now=out,
        )
    assert code_of(exc) == "needs_review"
    checkout.check_out(
        operator=gate.owner,
        booking_id=parked.pk,
        plate_number="01A777BC",
        collect=True,
        override=True,
        note="paid in cash",
        now=out,
    )

    parked = Booking.objects.get(pk=parked.pk)
    assert parked.paid_amount == parked.amount and parked.overstay_needs_review is False


@pytest.mark.parametrize(
    "snapshot",
    [
        {"price_per_hour": "not a number", "rules": {}},
        {"price_per_hour": "-5", "rules": {}},
        {"price_per_hour": "NaN", "rules": {}},
        {"rules": {}},
        {"price_per_hour": "6000", "rules": ["not", "a", "dict"]},
        ["list", "instead"],
        "text",
    ],
)
def test_damaged_tariff_snapshots_never_trap_the_car(gate, snapshot):
    booking = active(gate, tariff_snapshot=snapshot)

    leave(gate, booking, minutes_after_end=10)  # must not raise

    booking = Booking.objects.get(pk=booking.pk)
    assert booking.status == S.COMPLETED
    assert booking.overstay_needs_review is True
    assert booking.overstay_amount == BLOCK  # fell back to the lot's current tariff
    assert BookingEvent.objects.filter(booking=booking, reason="overstay_bad_terms").exists()


def test_damaged_coefficient_rules_charge_nothing_and_flag_for_review(gate):
    booking = active(
        gate,
        tariff_snapshot={"price_per_hour": "6000", "rules": {"coefficients": [{"from": "xx"}]}},
    )

    leave(gate, booking, minutes_after_end=10)

    booking = Booking.objects.get(pk=booking.pk)
    assert booking.status == S.COMPLETED
    assert (booking.overstay_amount, booking.overstay_needs_review) == (Decimal("0.00"), True)


def test_a_plate_typed_with_the_exit_qr_must_match(gate):
    booking = active(gate)
    token = exit_token(booking, gate.now)

    with pytest.raises(ApiError) as exc:
        qr_out(gate, token, plate_number="99Z999ZZ")
    assert code_of(exc) == "plate_mismatch"
    assert Booking.objects.get(pk=booking.pk).status == S.ACTIVE  # nothing spent

    assert qr_out(gate, token, plate_number=" " + booking.vehicle_plate.lower()).code == "completed"


def test_the_plate_is_checked_before_a_repeat_is_answered(gate):
    booking = active(gate)
    token = exit_token(booking, gate.now)
    qr_out(gate, token)

    with pytest.raises(ApiError) as exc:
        qr_out(gate, token, plate_number="99Z999ZZ", when=gate.now + timedelta(minutes=1))

    assert code_of(exc) == "plate_mismatch"


def test_an_out_of_service_slot_was_never_counted_so_its_car_is_not_subtracted(db):
    from apps.bookings import overstay
    from apps.bookings.conf import get_config

    gate = make_gate(slots=10)
    for other in gate.slots[1:]:  # nine busy slots; ours is FREE in the database at this moment
        Slot.objects.filter(pk=other.pk).update(status=SlotStatus.OCCUPIED)
    leaving = Slot.objects.get(pk=gate.slot.pk)
    leaving.status = SlotStatus.OCCUPIED
    odd = Slot.objects.get(pk=gate.slot.pk)
    odd.status = SlotStatus.OUT_OF_SERVICE

    counted = overstay.occupancy_now(gate.lot.pk, leaving, gate.now, get_config())
    uncounted = overstay.occupancy_now(gate.lot.pk, odd, gate.now, get_config())

    assert counted == Decimal("0.8")  # the leaving car's own slot is taken out of 9 busy
    assert uncounted == Decimal("0.9")  # nothing to take out: it was never counted
