"""Walk-in: a car without a booking, registered at the gate (ARCHITECTURE 6.3 point 5, Step 9)."""

import logging
from datetime import timedelta
from decimal import Decimal

import pytest

from apps.bookings import checkout, services, walkin
from apps.bookings.errors import NoSlotAvailable, VehicleBusy
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingKind
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError
from apps.parking.models import OperatorAssignment, ParkingLot, Slot, SlotStatus, SlotType
from tests.bookings.factories import make_booking, make_slot, make_vehicle, make_world
from tests.helpers import client_for, make_user
from tests.operators.helpers import book, make_gate

pytestmark = pytest.mark.django_db

PLATE = "01A777BC"


def register(gate, slot=None, plate=PLATE, vehicle_type="CAR", **kwargs):
    return walkin.register_walk_in(
        operator=kwargs.pop("operator", gate.operator),
        slot_id=(slot or gate.slot).pk,
        plate_number=plate,
        vehicle_type=vehicle_type,
        now=kwargs.pop("now", gate.now),
        **kwargs,
    )


def code_of(exc_info) -> str:
    return str(exc_info.value.detail["code"])


# --- success ----------------------------------------------------------------------------------


def test_walk_in_creates_an_active_booking_without_an_account(gate):
    booking = register(gate)

    booking = Booking.objects.get(pk=booking.pk)
    assert booking.kind == BookingKind.WALK_IN
    assert (booking.user_id, booking.vehicle_id) == (None, None)
    assert booking.vehicle_plate == PLATE
    assert booking.status == S.ACTIVE
    assert booking.checked_in_at == gate.now
    assert booking.starts_at == gate.now
    assert booking.ends_at == gate.now + timedelta(hours=4)
    assert (booking.amount, booking.paid_amount) == (Decimal("0.00"), Decimal("0.00"))
    assert booking.qr_nonce == ""


def test_walk_in_occupies_the_slot_and_updates_the_counter(gate):
    register(gate)

    assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.OCCUPIED
    assert ParkingLot.objects.get(pk=gate.lot.pk).free_slots == 1


def test_walk_in_is_logged_with_the_operator_as_actor(gate):
    booking = register(gate)

    event = BookingEvent.objects.get(booking=booking)
    assert (event.actor_id, event.from_status, event.to_status, event.reason) == (
        gate.operator.id,
        "",
        S.ACTIVE,
        "walk_in",
    )


def test_plate_is_normalised(gate):
    booking = register(gate, plate=" 01 a-777 bc ")

    assert booking.vehicle_plate == PLATE


def test_walk_in_ends_where_the_next_booking_on_the_slot_begins(gate):
    book(gate, start_min=180, end_min=300)  # CONFIRMED, starts in 3 hours

    booking = register(gate)

    assert booking.ends_at == gate.now + timedelta(hours=3, minutes=-5)  # 5 minute buffer


def test_walk_in_ends_before_the_next_booking_of_the_same_plate(gate):
    other_slot_vehicle = make_vehicle(gate.driver, plate=PLATE)
    book(gate, slot=gate.slots[1], vehicle=other_slot_vehicle, start_min=120, end_min=200)

    booking = register(gate)

    assert booking.ends_at == gate.now + timedelta(hours=2, minutes=-5)


def test_booking_just_after_the_gap_is_allowed(gate):
    book(gate, start_min=16, end_min=120)

    assert register(gate).ends_at == gate.now + timedelta(minutes=11)


def test_unpaid_hold_that_ran_out_does_not_block(gate):
    book(
        gate,
        status=S.PENDING_PAYMENT,
        start_min=5,
        end_min=65,
        hold_expires_at=gate.now - timedelta(minutes=1),
    )

    assert register(gate).status == S.ACTIVE


# --- refusals ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "code"),
    [(SlotStatus.OCCUPIED, "slot_occupied"), (SlotStatus.OUT_OF_SERVICE, "slot_out_of_service")],
)
def test_slot_must_be_physically_free(gate, status, code):
    Slot.objects.filter(pk=gate.slot.pk).update(status=status)

    with pytest.raises(ApiError) as exc:
        register(gate)

    assert (exc.value.status_code, code_of(exc)) == (409, code)
    assert Booking.objects.count() == 0


def test_reserved_slot_is_not_free(gate):
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.RESERVED)

    with pytest.raises(ApiError) as exc:
        register(gate)

    assert code_of(exc) == "slot_occupied"


def test_booking_starting_within_the_gap_blocks_the_walk_in(gate):
    book(gate, start_min=10, end_min=70)

    with pytest.raises(ApiError) as exc:
        register(gate)

    assert (exc.value.status_code, code_of(exc)) == (409, "slot_reserved_soon")


def test_booking_in_progress_on_the_slot_blocks_the_walk_in(gate):
    book(gate, start_min=-5, end_min=60)  # CONFIRMED, its driver is expected any minute

    with pytest.raises(ApiError) as exc:
        register(gate)

    assert code_of(exc) == "slot_reserved_soon"


def test_overstaying_car_keeps_the_slot_taken(gate):
    book(gate, status=S.OVERSTAY, start_min=-180, end_min=-30, checked_in_at=gate.now)
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)

    with pytest.raises(ApiError) as exc:
        register(gate)

    assert code_of(exc) == "slot_occupied"


def test_plate_that_is_already_parked_is_plate_busy(gate):
    register(gate, slot=gate.slots[0])

    with pytest.raises(ApiError) as exc:
        register(gate, slot=gate.slots[1])  # the same car cannot be in two slots

    assert (exc.value.status_code, code_of(exc)) == (409, "plate_busy")
    assert Booking.objects.count() == 1


def test_plate_with_a_booking_starting_soon_is_plate_busy(gate):
    vehicle = make_vehicle(gate.driver, plate=PLATE)
    book(gate, slot=gate.slots[1], vehicle=vehicle, start_min=5, end_min=60)

    with pytest.raises(ApiError) as exc:
        register(gate)

    assert code_of(exc) == "plate_busy"


def test_plate_busy_does_not_say_where_the_other_booking_is(gate):
    elsewhere = make_world(slots=1)
    stranger = make_user("DRIVER")
    make_booking(
        user=stranger,
        slot=elsewhere.slots[0],
        vehicle=make_vehicle(stranger, plate=PLATE),
        start=gate.now,
        end=gate.now + timedelta(hours=2),
        status=S.ACTIVE,
    )

    with pytest.raises(ApiError) as exc:
        register(gate)

    body = str(exc.value.detail)
    assert code_of(exc) == "plate_busy"
    assert str(elsewhere.lot.pk) not in body and elsewhere.lot.name not in body


def test_invalid_plate_is_unprocessable(gate):
    for bad in ("", "123", "ABCDEF", "01A 777 BC Ж", "x" * 40):
        with pytest.raises(ApiError) as exc:
            register(gate, plate=bad)
        assert (exc.value.status_code, code_of(exc)) == (422, "plate_invalid")


def test_declared_vehicle_type_must_fit_the_slot(db):
    gate = make_gate(slot_type=SlotType.EV)

    with pytest.raises(ApiError) as exc:
        register(gate, vehicle_type="CAR")  # a CAR cannot take an EV charging slot

    assert code_of(exc) == "vehicle_slot_mismatch"
    assert register(gate, vehicle_type="EV").status == S.ACTIVE


def test_vehicle_type_is_required(gate):
    with pytest.raises(TypeError):
        walkin.register_walk_in(
            operator=gate.operator, slot_id=gate.slot.pk, plate_number=PLATE, now=gate.now
        )


def test_slot_without_a_tariff_is_refused_up_front(gate):
    odd = make_slot(gate.zone, SlotType.LARGE)

    with pytest.raises(ApiError) as exc:
        register(gate, slot=odd, vehicle_type="TRUCK")

    assert code_of(exc) == "no_tariff"


def test_slot_of_another_lot_is_not_found(gate):
    other = make_world(slots=1)

    with pytest.raises(ApiError) as exc:
        register(gate, slot=other.slots[0])

    assert exc.value.status_code == 404
    assert Booking.objects.count() == 0


def test_driver_cannot_register_walk_ins(gate):
    with pytest.raises(ApiError) as exc:
        register(gate, operator=make_user("DRIVER"))

    assert exc.value.status_code == 404


def test_owner_registers_walk_ins_in_their_own_lot(gate):
    assert register(gate, operator=gate.owner).status == S.ACTIVE


def test_admin_registers_walk_ins_anywhere(gate):
    assert register(gate, operator=make_user("ADMIN")).status == S.ACTIVE


def test_operator_of_another_lot_is_not_found(gate):
    other = make_world(slots=1)
    visitor = make_user("OPERATOR")
    OperatorAssignment.objects.create(operator=visitor, parking_lot=other.lot)

    with pytest.raises(ApiError) as exc:
        register(gate, operator=visitor)

    assert exc.value.status_code == 404


def test_a_suspended_lot_takes_no_new_walk_ins(gate):
    from apps.parking.models import LotStatus

    ParkingLot.objects.filter(pk=gate.lot.pk).update(status=LotStatus.SUSPENDED)

    with pytest.raises(ApiError) as exc:
        register(gate)

    assert exc.value.status_code == 404


# --- interaction with online bookings ---------------------------------------------------------


def test_nobody_can_book_the_walk_ins_slot_afterwards(db):
    gate = make_gate(slots=1)
    register(gate)
    online_driver = make_user("DRIVER")

    with pytest.raises(NoSlotAvailable):
        services.create_booking(
            user=online_driver,
            lot_id=gate.lot.pk,
            slot_type="STANDARD",
            vehicle=make_vehicle(online_driver),
            start=gate.now + timedelta(hours=1),
            end=gate.now + timedelta(hours=2),
            now=gate.now,
        )


def test_the_walk_ins_plate_cannot_be_booked_online_meanwhile(gate):
    register(gate)
    owner_of_plate = make_user("DRIVER")

    with pytest.raises(VehicleBusy):
        services.create_booking(
            user=owner_of_plate,
            lot_id=gate.lot.pk,
            slot_type="STANDARD",
            vehicle=make_vehicle(owner_of_plate, plate=PLATE),
            start=gate.now + timedelta(hours=1),
            end=gate.now + timedelta(hours=2),
            now=gate.now,
        )


def test_audit_line_for_the_walk_in(gate, caplog, django_capture_on_commit_callbacks):
    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        register(gate)

    actions = {r.getMessage() for r in caplog.records}
    assert "audit booking.walk_in" in actions
    record = next(r for r in caplog.records if r.getMessage() == "audit booking.walk_in")
    assert record.audit_actor == str(gate.operator.id)


def test_walk_in_cannot_be_cancelled_or_listed_by_a_driver(gate):
    booking = register(gate)
    driver_client = client_for(gate.driver)

    assert driver_client.post(f"/api/v1/bookings/{booking.pk}/cancel").status_code == 404
    assert driver_client.get("/api/v1/bookings").data["count"] == 0


# --- leaving ----------------------------------------------------------------------------------


def leave(gate, booking, minutes, *, collect=False, operator=None):
    return checkout.check_out(
        operator=operator or gate.operator,
        booking_id=booking.pk,
        plate_number=booking.vehicle_plate,
        collect=collect,
        now=gate.now + timedelta(minutes=minutes),
    )


def test_leaving_within_the_free_window_costs_nothing(gate):
    booking = register(gate)

    result = leave(gate, booking, 10)

    booking = Booking.objects.get(pk=booking.pk)
    assert (booking.status, booking.amount, result.to_collect) == (
        S.COMPLETED,
        Decimal("0.00"),
        Decimal("0.00"),
    )
    assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.FREE


@pytest.mark.parametrize(
    ("minutes", "amount"),
    [(11, "1500.00"), (25, "1500.00"), (26, "3000.00"), (70, "6000.00"), (130, "12000.00")],
)
def test_walk_in_pays_the_tariff_for_the_whole_stay(gate, minutes, amount):
    booking = register(gate)

    result = leave(gate, booking, minutes)

    booking = Booking.objects.get(pk=booking.pk)
    assert booking.amount == Decimal(amount)
    assert result.to_collect == Decimal(amount)  # not collected yet
    assert (booking.overstay_status, booking.overstay_amount) == ("none", Decimal("0.00"))


def test_collect_marks_the_walk_in_paid(gate):
    booking = register(gate)

    result = leave(gate, booking, 70, collect=True)

    booking = Booking.objects.get(pk=booking.pk)
    assert (booking.amount, booking.paid_amount) == (Decimal("6000.00"), Decimal("6000.00"))
    assert result.to_collect == Decimal("0.00")


def test_repeating_with_collect_settles_the_walk_in(gate):
    booking = register(gate)
    leave(gate, booking, 70)

    again = leave(gate, booking, 75, collect=True)

    booking = Booking.objects.get(pk=booking.pk)
    assert again.code == "already_completed"
    assert booking.paid_amount == booking.amount == Decimal("6000.00")


def test_walk_in_past_its_period_is_charged_the_whole_stay_not_an_overstay(gate):
    book(gate, start_min=60, end_min=120)  # the slot is needed in an hour
    booking = register(gate)
    assert booking.ends_at == gate.now + timedelta(minutes=55)  # 5 minute buffer
    services.detect_overstays(now=gate.now + timedelta(minutes=70))
    assert Booking.objects.get(pk=booking.pk).status == S.OVERSTAY

    leave(gate, booking, 100, collect=True)

    booking = Booking.objects.get(pk=booking.pk)
    assert booking.amount == Decimal("9000.00")  # 100 minutes: 90 billable = 6 blocks
    assert (booking.overstay_status, booking.overstay_amount) == ("none", Decimal("0.00"))


def test_walk_in_leaves_by_plate_but_an_online_booking_needs_its_qr(gate):
    parked = register(gate)
    online = book(
        gate,
        slot=gate.slots[1],
        status=S.ACTIVE,
        start_min=-60,
        end_min=60,
        checked_in_at=gate.now - timedelta(minutes=60),
    )

    assert leave(gate, parked, 5).code == "completed"
    with pytest.raises(ApiError) as exc:
        leave(gate, online, 5)
    assert code_of(exc) == "exit_qr_required"


# --- limits, snapshot, audit row ---------------------------------------------------------------


def test_an_operator_cannot_register_more_than_the_hourly_limit(db, settings):
    settings.OPERATOR_WALKIN_PER_HOUR = 3
    gate = make_gate(slots=5)
    for index in range(3):
        register(gate, slot=gate.slots[index], plate=f"01A10{index}BC")

    with pytest.raises(ApiError) as exc:
        register(gate, slot=gate.slots[3], plate="01A104BC")

    assert (exc.value.status_code, code_of(exc)) == (429, "walk_in_rate_limited")
    assert Booking.objects.count() == 3


def test_the_hourly_limit_is_per_operator_and_per_hour(db, settings):
    settings.OPERATOR_WALKIN_PER_HOUR = 2
    gate = make_gate(slots=6)
    colleague = make_user("OPERATOR")
    OperatorAssignment.objects.create(operator=colleague, parking_lot=gate.lot)
    register(gate, slot=gate.slots[0], plate="01A100BC")
    register(gate, slot=gate.slots[1], plate="01A101BC")

    assert (
        register(gate, slot=gate.slots[2], plate="01A102BC", operator=colleague).status == S.ACTIVE
    )
    with pytest.raises(ApiError):
        register(gate, slot=gate.slots[3], plate="01A103BC")
    later = gate.now + timedelta(hours=2)  # the earlier two are more than an hour old by then
    assert register(gate, slot=gate.slots[3], plate="01A103BC", now=later).status == S.ACTIVE


def test_the_tariff_of_the_moment_is_frozen_into_the_walk_in(gate):
    booking = register(gate)

    assert Booking.objects.get(pk=booking.pk).tariff_snapshot == {
        "price_per_hour": "6000.00",
        "rules": {},
    }


def test_a_later_price_change_does_not_reprice_a_stay_that_began_before_it(gate):
    from apps.parking.models import Tariff

    booking = register(gate)
    Tariff.objects.filter(parking_lot=gate.lot).update(price_per_hour=Decimal("60000"))

    leave(gate, booking, 70)

    assert Booking.objects.get(pk=booking.pk).amount == Decimal("6000.00")  # not 60 000


def test_the_walk_in_leaves_a_persisted_audit_row(gate):
    from apps.audit.models import AuditLog

    booking = register(gate)

    row = AuditLog.objects.get(action="booking.walk_in")
    assert row.target_id == str(booking.pk)
    assert row.actor_id == gate.operator.id
    assert "01A777BC" not in str(row.meta)  # no plate in the audit table


def test_every_attempt_is_audited_with_its_outcome(
    gate, caplog, django_capture_on_commit_callbacks
):
    Slot.objects.filter(pk=gate.slots[1].pk).update(status=SlotStatus.OCCUPIED)

    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        register(gate, slot=gate.slots[0])
        with pytest.raises(ApiError):
            register(gate, slot=gate.slots[1], plate="01A222BC")

    outcomes = [
        r.audit_after["outcome"]
        for r in caplog.records
        if r.getMessage() == "audit operator.walk_in"
    ]
    assert outcomes == ["registered", "slot_occupied"]


# --- refused attempts count too (plate_busy is an oracle) -----------------------------------------


def test_ten_refused_walk_ins_in_a_minute_lock_walk_ins_for_that_operator(gate):
    register(gate, slot=gate.slots[0], plate="01A111BC")  # slot 0 and this plate are now taken

    for _ in range(10):  # probing: "is this plate booked somewhere?"
        with pytest.raises(ApiError) as exc:
            register(gate, slot=gate.slots[1], plate="01A111BC")
        assert code_of(exc) == "plate_busy"

    with pytest.raises(ApiError) as locked:
        register(gate, slot=gate.slots[1], plate="01A222BC")  # even an innocent one now waits
    assert (locked.value.status_code, code_of(locked)) == (429, "walk_in_rate_limited")
    assert locked.value.wait >= 1
    assert Booking.objects.count() == 1


def test_the_refusal_limit_is_per_operator(gate):
    colleague = make_user("OPERATOR")
    OperatorAssignment.objects.create(operator=colleague, parking_lot=gate.lot)
    register(gate, slot=gate.slots[0], plate="01A111BC")
    for _ in range(10):
        with pytest.raises(ApiError):
            register(gate, slot=gate.slots[1], plate="01A111BC")

    assert (
        register(gate, slot=gate.slots[1], plate="01A333BC", operator=colleague).status == S.ACTIVE
    )


def test_successful_walk_ins_do_not_use_up_the_refusal_budget(db):
    gate = make_gate(slots=14)
    for index in range(12):
        register(gate, slot=gate.slots[index], plate=f"01A4{index:02d}BC")

    assert register(gate, slot=gate.slots[12], plate="01A999BC").status == S.ACTIVE


def test_a_walk_in_ends_after_four_hours_unless_the_operator_closes_it_earlier(gate):
    booking = register(gate)

    assert booking.ends_at == gate.now + timedelta(hours=4)
    services.detect_overstays(now=gate.now + timedelta(hours=4, minutes=1))
    assert Booking.objects.get(pk=booking.pk).status == S.OVERSTAY  # the automatic overstay rule


# --- through the API -----------------------------------------------------------------------------


WALK_IN_URL = "/api/v1/operator/walk-in"


def api_walk_in(client, gate, **extra):
    body = {"slot_id": str(gate.slot.pk), "plate_number": PLATE, "vehicle_type": "CAR", **extra}
    return client.post(WALK_IN_URL, body, format="json")


def test_api_registers_a_walk_in_for_the_assigned_operator(gate):
    response = api_walk_in(client_for(gate.operator), gate)

    assert response.status_code == 201
    assert response.json()["booking"]["kind"] == "WALK_IN"


def test_api_vehicle_type_is_required(gate):
    body = {"slot_id": str(gate.slot.pk), "plate_number": PLATE}

    assert client_for(gate.operator).post(WALK_IN_URL, body, format="json").status_code == 400


def test_api_permission_matrix(gate):
    other = make_world(slots=1)
    visitor = make_user("OPERATOR")
    OperatorAssignment.objects.create(operator=visitor, parking_lot=other.lot)

    assert api_walk_in(client_for(make_user("DRIVER")), gate).status_code == 403
    assert api_walk_in(client_for(visitor), gate).status_code == 404  # another lot: no probing
    assert api_walk_in(client_for(make_user("OWNER")), gate).status_code == 404
    assert api_walk_in(client_for(gate.owner), gate).status_code == 201


def test_api_throttles_to_thirty_a_minute(gate):
    client = client_for(gate.operator)
    codes = [api_walk_in(client, gate, plate_number=f"01A{i:03d}BC").status_code for i in range(31)]

    assert 429 in codes[-3:]


def test_api_flood_of_refusals_answers_429_with_retry_after(gate):
    client = client_for(gate.operator)
    api_walk_in(client, gate)  # slot taken from now on
    responses = [api_walk_in(client, gate, plate_number=f"01A{i:03d}BC") for i in range(11)]

    last = responses[-1]
    assert last.status_code == 429
    assert last.json()["code"] == "walk_in_rate_limited"
    assert int(last["Retry-After"]) >= 1
