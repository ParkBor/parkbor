"""Operator API contract: /api/v1/operator/checkin, checkout, walk-in (ARCHITECTURE 9.2)."""

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.parking.models import OperatorAssignment, Slot, SlotStatus
from tests.bookings.factories import make_world
from tests.helpers import client_for
from tests.operators.helpers import book, entry_token, exit_token

pytestmark = pytest.mark.django_db

BOOKING_KEYS = {
    "id",
    "status",
    "kind",
    "plate_number",
    "slot",
    "parking_lot",
    "start",
    "end",
    "amount",
    "paid_amount",
    "checked_in_at",
    "checked_out_at",
    "overstay_minutes",
    "overstay_amount",
    "overstay_status",
    "overstay_needs_review",
}


@pytest.fixture
def api(gate):
    return client_for(gate.operator)


def checkin(api, token, **extra):
    return api.post("/api/v1/operator/checkin", {"qr_token": token, **extra}, format="json")


def checkout(api, **body):
    return api.post("/api/v1/operator/checkout", body, format="json")


def parked(gate, *, end_min=60, **extra):
    booking = book(
        gate,
        status=S.ACTIVE,
        start_min=-60,
        end_min=end_min,
        checked_in_at=gate.now - timedelta(minutes=60),
        **extra,
    )
    Slot.objects.filter(pk=booking.slot_id).update(status=SlotStatus.OCCUPIED)
    return booking


# --- check-in ---------------------------------------------------------------------------------


def test_checkin_200_shape_is_the_documented_contract(gate, api):
    booking = book(gate)

    response = checkin(api, entry_token(booking))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"allowed", "result", "booking", "next"}
    assert (body["allowed"], body["result"]) == (True, "checked_in")
    assert set(body["booking"]) == BOOKING_KEYS
    assert body["booking"]["status"] == "ACTIVE"
    assert body["booking"]["plate_number"] == booking.vehicle_plate
    assert body["booking"]["slot"]["code"] == gate.slot.code
    assert body["booking"]["slot"]["zone"] == "A"
    assert body["booking"]["slot"]["floor"] == 1
    assert body["booking"]["parking_lot"] == {"id": str(gate.lot.id), "name": gate.lot.name}
    assert body["next"]["overstay"] == {
        "free_minutes": 0,
        "block_minutes": 15,
        "price_per_block": "1500.00",
        "collected_at_exit": True,
    }
    assert body["next"]["checkout_by"] == body["booking"]["end"]
    assert response["Cache-Control"] == "no-store"


def test_checkin_never_shows_who_the_driver_is(gate, api):
    gate.driver.first_name, gate.driver.phone = "Aziza", "+998901112233"
    gate.driver.telegram_username = "aziza_driver"
    gate.driver.save()
    booking = book(gate)

    response = checkin(api, entry_token(booking))

    raw = response.content.decode()
    for secret in ("Aziza", "998901112233", "aziza_driver", str(gate.driver.id)):
        assert secret not in raw


def test_checkin_twice_answers_already_checked_in(gate, api):
    booking = book(gate)
    token = entry_token(booking)
    first = checkin(api, token)

    again = checkin(api, token)

    assert (first.json()["allowed"], first.json()["result"]) == (True, "checked_in")
    assert again.status_code == 200
    assert (again.json()["allowed"], again.json()["result"]) == (False, "already_checked_in")


@pytest.mark.parametrize(
    ("status", "http", "code"),
    [
        (S.PENDING_PAYMENT, 409, "booking_not_paid"),
        (S.CANCELLED, 409, "booking_cancelled"),
        (S.EXPIRED, 409, "booking_expired"),
        (S.NO_SHOW, 409, "booking_no_show"),
    ],
)
def test_checkin_refusals_are_error_bodies_with_the_reason_code(gate, api, status, http, code):
    booking = book(gate, status=status)

    response = checkin(api, entry_token(booking))

    assert response.status_code == http
    assert response.json()["code"] == code
    assert set(response.json()) == {"detail", "code"}


def test_checkin_garbage_token_is_400_qr_invalid(gate, api):
    response = checkin(api, "not-a-real-token")

    assert (response.status_code, response.json()["code"]) == (400, "qr_invalid")


def test_checkin_validation(gate, api):
    assert api.post("/api/v1/operator/checkin", {}, format="json").status_code == 400
    assert checkin(api, "x" * 5000).status_code == 400
    assert checkin(api, "abc", parking_lot_id="nope").status_code == 400


def test_checkin_with_the_wrong_lot_selected_is_wrong_lot(gate, api):
    import uuid

    booking = book(gate)

    response = checkin(api, entry_token(booking), parking_lot_id=str(uuid.uuid4()))

    assert (response.status_code, response.json()["code"]) == (409, "wrong_lot")


# --- check-out --------------------------------------------------------------------------------


def test_checkout_by_exit_qr_200_shape(gate, api):
    booking = parked(gate)
    token = exit_token(booking, gate.now)

    response = checkout(api, qr_token=token)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "allowed",
        "result",
        "booking",
        "actual_minutes",
        "overstay",
        "to_collect",
    }
    assert body["result"] == "completed"
    assert set(body["booking"]) == BOOKING_KEYS
    assert body["booking"]["status"] == "COMPLETED"
    assert body["overstay"] == {"minutes": 0, "amount": "0.00", "status": "none"}
    assert body["to_collect"] == "0.00"
    assert body["actual_minutes"] >= 0


def test_checkout_overstay_is_priced_then_settled_in_two_steps(gate, api):
    booking = parked(gate, end_min=-20)  # ended 20 minutes ago
    token = exit_token(booking, gate.now)

    first = checkout(api, qr_token=token).json()
    second = checkout(api, qr_token=token, collect=True).json()

    assert first["result"] == "completed"
    assert first["overstay"]["minutes"] in (20, 21)  # a started minute counts
    assert (first["overstay"]["amount"], first["overstay"]["status"]) == ("3000.00", "due")
    assert first["to_collect"] == "3000.00"
    assert second["result"] == "already_completed"
    assert second["overstay"]["status"] == "collected"
    assert second["to_collect"] == "0.00"


def test_checkout_by_hand_needs_the_plate(gate, api):
    booking = parked(gate)

    missing = checkout(api, booking_id=str(booking.pk))
    wrong = checkout(api, booking_id=str(booking.pk), plate_number="99Z999ZZ")

    assert missing.status_code == 400
    assert (wrong.status_code, wrong.json()["code"]) == (409, "plate_mismatch")


def test_an_online_booking_cannot_leave_by_plate_but_a_walk_in_can(gate, api):
    booking = parked(gate)
    walk = api.post(
        "/api/v1/operator/walk-in",
        {"slot_id": str(gate.slots[1].pk), "plate_number": "01A555BC", "vehicle_type": "CAR"},
        format="json",
    ).json()["booking"]

    online = checkout(api, booking_id=str(booking.pk), plate_number=booking.vehicle_plate)
    walked = checkout(api, booking_id=walk["id"], plate_number="01A555BC")

    assert (online.status_code, online.json()["code"]) == (403, "exit_qr_required")
    assert walked.status_code == 200


def test_owner_override_needs_a_note_and_the_owner_role(gate, api):
    booking = parked(gate)
    body = {"booking_id": str(booking.pk), "plate_number": booking.vehicle_plate}

    no_note = checkout(client_for(gate.owner), **body, override=True)
    no_booking = checkout(client_for(gate.owner), qr_token="x", override=True, note="why")
    operator = checkout(api, **body, override=True, note="phone is dead")
    owner = checkout(client_for(gate.owner), **body, override=True, note="phone is dead")

    assert no_note.status_code == 400 and no_booking.status_code == 400
    assert (operator.status_code, operator.json()["code"]) == (403, "exit_qr_required")
    assert owner.status_code == 200
    assert owner.json()["booking"]["status"] == "COMPLETED"


def test_checkout_needs_exactly_one_identifier(gate, api):
    booking = parked(gate)

    assert checkout(api).status_code == 400
    both = checkout(api, qr_token="x", booking_id=str(booking.pk), plate_number="01A123BC")
    assert both.status_code == 400


def test_checkout_of_a_booking_that_never_entered(gate, api):
    booking = book(gate)

    response = checkout(api, qr_token=exit_token(booking, gate.now))

    assert (response.status_code, response.json()["code"]) == (409, "not_checked_in")


def test_checkout_unknown_booking_is_404(gate, api):
    import uuid

    response = checkout(api, booking_id=str(uuid.uuid4()), plate_number="01A123BC")

    assert (response.status_code, response.json()["code"]) == (404, "booking_not_found")


# --- walk-in ----------------------------------------------------------------------------------


def test_walk_in_201_shape_and_effect(gate, api):
    response = api.post(
        "/api/v1/operator/walk-in",
        {"slot_id": str(gate.slot.pk), "plate_number": "01 a 555 bc", "vehicle_type": "CAR"},
        format="json",
    )

    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"result", "booking", "valid_until"}
    assert body["result"] == "registered"
    assert set(body["booking"]) == BOOKING_KEYS
    assert (body["booking"]["kind"], body["booking"]["status"]) == ("WALK_IN", "ACTIVE")
    assert body["booking"]["plate_number"] == "01A555BC"
    assert body["valid_until"] == body["booking"]["end"]
    assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.OCCUPIED


def test_walk_in_errors(gate, api):
    url = "/api/v1/operator/walk-in"
    slot = str(gate.slot.pk)
    ok = {"slot_id": slot, "vehicle_type": "CAR"}

    assert api.post(url, {}, format="json").status_code == 400
    assert api.post(url, {"slot_id": slot}, format="json").status_code == 400
    bad_type = api.post(
        url, {"slot_id": slot, "plate_number": "01A555BC", "vehicle_type": "BOAT"}, format="json"
    )
    assert bad_type.status_code == 400
    bad_plate = api.post(url, {**ok, "plate_number": "??"}, format="json")
    assert (bad_plate.status_code, bad_plate.json()["code"]) == (422, "plate_invalid")
    assert (
        api.post(url, {"slot_id": slot, "plate_number": "01A555BC"}, format="json").status_code
        == 400
    )
    api.post(url, {**ok, "plate_number": "01A555BC"}, format="json")
    taken = api.post(url, {**ok, "plate_number": "01A556BC"}, format="json")
    assert (taken.status_code, taken.json()["code"]) == (409, "slot_occupied")


# --- full journey -----------------------------------------------------------------------------


def test_driver_qr_to_check_in_to_exit_qr_to_check_out(gate, api):
    booking = book(gate)
    driver = client_for(gate.driver)

    entry = driver.get(f"/api/v1/bookings/{booking.pk}/qr").json()
    assert entry["purpose"] == "entry"
    assert checkin(api, entry["qr_token"]).json()["result"] == "checked_in"

    leaving = driver.get(f"/api/v1/bookings/{booking.pk}/qr").json()
    assert leaving["purpose"] == "exit"
    assert leaving["qr_token"] != entry["qr_token"]
    assert checkout(api, qr_token=entry["qr_token"]).json()["code"] == "qr_wrong_purpose"
    done = checkout(api, qr_token=leaving["qr_token"]).json()

    assert done["booking"]["status"] == "COMPLETED"
    assert Booking.objects.get(pk=booking.pk).status == S.COMPLETED
    assert driver.get(f"/api/v1/bookings/{booking.pk}/qr").status_code == 409


def test_the_exit_qr_can_be_asked_for_again_and_both_work_once(gate, api):
    booking = book(gate)
    driver = client_for(gate.driver)
    checkin(api, driver.get(f"/api/v1/bookings/{booking.pk}/qr").json()["qr_token"])

    first = driver.get(f"/api/v1/bookings/{booking.pk}/qr").json()["qr_token"]
    second = driver.get(f"/api/v1/bookings/{booking.pk}/qr").json()["qr_token"]

    assert checkout(api, qr_token=first).json()["result"] == "completed"
    assert checkout(api, qr_token=second).json()["result"] == "already_completed"


def test_overstay_status_gets_an_exit_qr_too(gate):
    booking = book(gate, status=S.OVERSTAY, start_min=-130, end_min=-10, checked_in_at=gate.now)

    response = client_for(gate.driver).get(f"/api/v1/bookings/{booking.pk}/qr")

    assert response.status_code == 200
    assert response.json()["purpose"] == "exit"


def test_amounts_are_strings_with_two_decimals(gate, api):
    booking = parked(gate, end_min=-1)

    body = checkout(api, qr_token=exit_token(booking, gate.now)).json()

    assert body["overstay"]["amount"] == "1500.00"
    assert Decimal(body["to_collect"]) == Decimal("1500.00")
    assert isinstance(body["actual_minutes"], int)


# --- red / amber / green, plate, lot scope, headers -----------------------------------------------


def test_checkin_plate_number_is_optional_and_checked_when_given(gate, api):
    booking = book(gate)
    token = entry_token(booking)

    wrong = checkin(api, token, plate_number="99Z999ZZ")
    right = checkin(api, token, plate_number=booking.vehicle_plate)

    assert (wrong.status_code, wrong.json()["code"]) == (409, "plate_mismatch")
    assert right.json()["allowed"] is True


def test_an_operator_of_several_lots_must_say_which_one(gate, api):
    other = make_world(slots=1)
    OperatorAssignment.objects.create(operator=gate.operator, parking_lot=other.lot)
    booking = book(gate)
    token = entry_token(booking)

    unsure = checkin(api, token)
    sure = checkin(api, token, parking_lot_id=str(gate.lot.id))
    leaving = checkout(api, qr_token="x")

    assert (unsure.status_code, unsure.json()["code"]) == (400, "parking_lot_required")
    assert sure.status_code == 200
    assert leaving.json()["code"] == "parking_lot_required"


def test_errors_are_never_cached_either(gate, api):
    refused = checkin(api, "forged")
    missing = api.get(f"/api/v1/operator/parkings/{uuid.uuid4()}/slots")

    assert refused.status_code == 400 and refused["Cache-Control"] == "no-store"
    assert missing.status_code == 404 and missing["Cache-Control"] == "no-store"


def test_a_repeated_exit_scan_is_amber_not_green(gate, api):
    booking = parked(gate)
    token = exit_token(booking, gate.now)

    first = checkout(api, qr_token=token).json()
    again = checkout(api, qr_token=token).json()

    assert (first["allowed"], first["result"]) == (True, "completed")
    assert (again["allowed"], again["result"]) == (False, "already_completed")


def test_exit_qr_with_a_plate_that_does_not_match_is_refused(gate, api):
    booking = parked(gate)

    response = checkout(api, qr_token=exit_token(booking, gate.now), plate_number="99Z999ZZ")

    assert (response.status_code, response.json()["code"]) == (409, "plate_mismatch")


def test_the_booking_view_carries_the_review_flag(gate, api):
    booking = parked(gate)

    body = checkout(api, qr_token=exit_token(booking, gate.now)).json()

    assert body["booking"]["overstay_needs_review"] is False
