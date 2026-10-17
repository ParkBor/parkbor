"""GET /operator/parkings/{id}/slots: the gate's slot map (zone, floor, code, type, status,
current and next booking), PII-minimal and free of per-slot queries."""

from datetime import timedelta

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.bookings.state import BookingStatus as S
from apps.parking.models import SlotStatus, SlotType, Zone
from tests.bookings.factories import make_slot, make_vehicle
from tests.helpers import client_for
from tests.operators.helpers import book, make_gate

pytestmark = pytest.mark.django_db


def fetch(gate, user=None):
    response = client_for(user or gate.operator).get(
        f"/api/v1/operator/parkings/{gate.lot.id}/slots"
    )
    assert response.status_code == 200
    return response.json()


def by_code(body):
    return {row["code"]: row for row in body["slots"]}


def test_shape(gate):
    body = fetch(gate)

    assert set(body) == {"parking_lot", "slots", "truncated"}
    assert body["truncated"] is False
    assert set(body["parking_lot"]) == {
        "id",
        "name",
        "address",
        "status",
        "open_time",
        "close_time",
        "total_slots",
        "free_slots",
    }
    assert len(body["slots"]) == 2
    row = body["slots"][0]
    assert set(row) == {
        "id",
        "code",
        "zone",
        "floor",
        "type",
        "status",
        "current_booking",
        "next_booking",
    }
    assert (row["zone"], row["floor"], row["type"], row["status"]) == (
        "A",
        1,
        "STANDARD",
        "FREE",
    )
    assert row["current_booking"] is None and row["next_booking"] is None


def test_current_and_next_booking_with_plate_and_times_only(gate):
    parked = book(
        gate,
        status=S.ACTIVE,
        start_min=-60,
        end_min=30,
        checked_in_at=gate.now - timedelta(minutes=60),
    )
    later = book(
        gate,
        vehicle=make_vehicle(gate.driver, plate="01B222CD"),
        start_min=60,
        end_min=120,
    )

    row = by_code(fetch(gate))[gate.slot.code]

    assert set(row["current_booking"]) == {"id", "status", "kind", "plate_number", "start", "end"}
    assert row["current_booking"]["id"] == str(parked.id)
    assert row["current_booking"]["plate_number"] == parked.vehicle_plate
    assert row["current_booking"]["status"] == "ACTIVE"
    assert row["next_booking"]["id"] == str(later.id)
    assert row["next_booking"]["plate_number"] == "01B222CD"
    assert row["next_booking"]["status"] == "CONFIRMED"


def test_overstay_and_walk_in_are_shown_as_current(gate):
    book(gate, status=S.OVERSTAY, start_min=-200, end_min=-20, checked_in_at=gate.now)

    row = by_code(fetch(gate))[gate.slot.code]

    assert row["current_booking"]["status"] == "OVERSTAY"


def test_only_confirmed_waiting_bookings_count_as_next(gate):
    book(gate, status=S.PENDING_PAYMENT, start_min=60, end_min=120, hold_expires_at=gate.now)
    book(gate, status=S.CANCELLED, start_min=60, end_min=120)
    book(gate, status=S.COMPLETED, start_min=-300, end_min=-200)
    book(gate, status=S.NO_SHOW, start_min=-300, end_min=-200)

    row = by_code(fetch(gate))[gate.slot.code]

    assert row["next_booking"] is None and row["current_booking"] is None


def test_next_is_the_earliest_and_far_future_is_left_out(gate, settings):
    soon = book(gate, start_min=60, end_min=100)
    book(gate, start_min=300, end_min=400)
    book(
        gate,
        slot=gate.slots[1],
        start_min=settings.OPERATOR_MAP_HORIZON_HOURS * 60 + 60,
        end_min=settings.OPERATOR_MAP_HORIZON_HOURS * 60 + 120,
    )

    rows = by_code(fetch(gate))

    assert rows[gate.slot.code]["next_booking"]["id"] == str(soon.id)
    assert rows[gate.slots[1].code]["next_booking"] is None


def test_no_personal_data_anywhere_in_the_response(gate):
    gate.driver.first_name, gate.driver.last_name = "Aziza", "Karimova"
    gate.driver.phone, gate.driver.telegram_username = "+998901112233", "aziza_k"
    gate.driver.save()
    book(gate, status=S.ACTIVE, start_min=-60, end_min=30, checked_in_at=gate.now)
    book(gate, start_min=60, end_min=100, slot=gate.slot)

    response = client_for(gate.operator).get(f"/api/v1/operator/parkings/{gate.lot.id}/slots")

    raw = response.content.decode()
    for secret in ("Aziza", "Karimova", "998901112233", "aziza_k", str(gate.driver.id)):
        assert secret not in raw


def test_ordered_by_floor_zone_code_and_all_types_are_shown(db):
    gate = make_gate(slots=1)
    upper = Zone.objects.create(parking_lot=gate.lot, name="B", floor=2)
    make_slot(upper, SlotType.EV, code="B-1")
    make_slot(gate.zone, SlotType.DISABLED, code="A-0", status=SlotStatus.OUT_OF_SERVICE)

    rows = fetch(gate)["slots"]

    assert [r["code"] for r in rows] == ["A-0", gate.slot.code, "B-1"]
    assert [r["floor"] for r in rows] == [1, 1, 2]
    assert [r["type"] for r in rows] == ["DISABLED", "STANDARD", "EV"]
    assert rows[0]["status"] == "OUT_OF_SERVICE"


def queries_for(gate, user):
    client = client_for(user)
    with CaptureQueriesContext(connection) as captured:
        assert client.get(f"/api/v1/operator/parkings/{gate.lot.id}/slots").status_code == 200
    return len(captured)


def test_query_count_does_not_grow_with_the_lot(db):
    small = make_gate(slots=3)
    big = make_gate(slots=40)
    for index, slot in enumerate(big.slots[:30]):
        book(big, slot=slot, vehicle=make_vehicle(big.driver), start_min=60 + index, end_min=200)
        book(
            big,
            slot=slot,
            status=S.ACTIVE,
            vehicle=make_vehicle(big.driver),
            start_min=-100,
            end_min=30,
            checked_in_at=big.now,
        )
    book(small, start_min=60, end_min=100)

    assert queries_for(small, small.operator) == queries_for(big, big.operator)


def test_a_far_away_booking_keeps_its_plate_hidden_but_its_id_stays(gate):
    near = book(
        gate, start_min=60, end_min=100, vehicle=make_vehicle(gate.driver, plate="01B222CD")
    )
    far = book(gate, slot=gate.slots[1], start_min=600, end_min=700)

    rows = by_code(fetch(gate))

    near_row = rows[gate.slot.code]["next_booking"]
    far_row = rows[gate.slots[1].code]["next_booking"]
    assert (near_row["id"], near_row["plate_number"]) == (str(near.id), "01B222CD")
    assert (far_row["id"], far_row["plate_number"]) == (str(far.id), None)


def test_the_map_is_capped_and_says_so(gate, settings):
    settings.OPERATOR_MAP_MAX_SLOTS = 1

    body = fetch(gate)

    assert len(body["slots"]) == 1
    assert body["truncated"] is True


def test_the_map_still_works_in_a_suspended_lot(gate):
    from apps.parking.models import LotStatus, ParkingLot

    ParkingLot.objects.filter(pk=gate.lot.pk).update(status=LotStatus.SUSPENDED)

    body = fetch(gate)

    assert body["parking_lot"]["status"] == "SUSPENDED"
    assert len(body["slots"]) == 2
