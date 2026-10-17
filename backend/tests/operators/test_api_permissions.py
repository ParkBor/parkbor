"""Who may call the operator API: anonymous / DRIVER / OPERATOR (own, other lot) / OWNER / ADMIN."""

import uuid
from datetime import timedelta

import pytest
from rest_framework.test import APIClient

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.parking.models import LotStatus, OperatorAssignment, ParkingLot, Slot, SlotStatus
from tests.bookings.factories import make_world
from tests.helpers import client_for, make_user
from tests.operators.helpers import book, entry_token

pytestmark = pytest.mark.django_db

BASE = "/api/v1/operator"


def actors(gate):
    """name -> (client, may it operate gate's lot?)"""
    other_lot_operator = make_user("OPERATOR")
    OperatorAssignment.objects.create(
        operator=other_lot_operator, parking_lot=make_world(slots=1).lot
    )
    return {
        "anonymous": (APIClient(), False),
        "driver": (client_for(make_user("DRIVER")), False),
        "operator_of_another_lot": (client_for(other_lot_operator), False),
        "unassigned_operator": (client_for(make_user("OPERATOR")), False),
        "foreign_owner": (client_for(make_user("OWNER")), False),
        "operator": (client_for(gate.operator), True),
        "owner": (client_for(gate.owner), True),
        "admin": (client_for(make_user("ADMIN")), True),
    }


def call(client, method, path, body=None):
    return getattr(client, method)(f"{BASE}{path}", body, format="json")


def assert_denied(response, name):
    """Nobody without access learns anything: 401 anonymous, 403 wrong role, else 404/409."""
    if name == "anonymous":
        assert response.status_code == 401
    elif name == "driver":
        assert response.status_code == 403
    else:
        assert response.status_code in (403, 404, 409), (name, response.status_code)


def test_lot_list_matrix(gate):
    for name, (client, allowed) in actors(gate).items():
        response = call(client, "get", "/parkings")
        if name in ("anonymous", "driver"):
            assert_denied(response, name)
            continue
        ids = {row["id"] for row in response.json()["results"]}
        assert (str(gate.lot.id) in ids) == allowed, name


def test_slot_map_matrix(gate):
    for name, (client, allowed) in actors(gate).items():
        response = call(client, "get", f"/parkings/{gate.lot.id}/slots")
        if allowed:
            assert response.status_code == 200, name
        else:
            assert_denied(response, name)
            assert response.status_code != 200


def test_checkin_matrix(gate):
    booking = book(gate)
    token = entry_token(booking)
    clients = actors(gate)
    for name, (client, allowed) in clients.items():
        if allowed:
            continue
        response = call(client, "post", "/checkin", {"qr_token": token})
        assert_denied(response, name)
        assert response.status_code != 200
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED
    assert call(clients["operator"][0], "post", "/checkin", {"qr_token": token}).status_code == 200


@pytest.mark.parametrize("who", ["owner", "admin"])
def test_owner_and_admin_may_check_in(gate, who):
    client, allowed = actors(gate)[who]
    booking = book(gate)

    response = call(
        client,
        "post",
        "/checkin",
        {"qr_token": entry_token(booking), "parking_lot_id": str(gate.lot.id)},
    )

    assert allowed
    assert response.status_code == 200


def test_checkout_matrix(gate):
    booking = book(
        gate,
        status=S.ACTIVE,
        start_min=-60,
        end_min=60,
        checked_in_at=gate.now - timedelta(minutes=60),
    )
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)
    body = {"booking_id": str(booking.pk), "plate_number": booking.vehicle_plate}
    for name, (client, allowed) in actors(gate).items():
        if allowed:
            continue
        response = call(client, "post", "/checkout", body)
        assert_denied(response, name)
        assert response.status_code != 200
    override = {**body, "override": True, "note": "phone dead"}
    assert call(actors(gate)["owner"][0], "post", "/checkout", override).status_code == 200


def test_walk_in_matrix(gate):
    body = {"slot_id": str(gate.slot.pk), "plate_number": "01A555BC", "vehicle_type": "CAR"}
    for name, (client, allowed) in actors(gate).items():
        if allowed:
            continue
        response = call(client, "post", "/walk-in", body)
        assert_denied(response, name)
        assert response.status_code != 201
    assert call(actors(gate)["operator"][0], "post", "/walk-in", body).status_code == 201


def test_slot_patch_matrix(gate):
    body = {"status": "OUT_OF_SERVICE"}
    for name, (client, allowed) in actors(gate).items():
        if allowed:
            continue
        response = call(client, "patch", f"/slots/{gate.slot.pk}", body)
        assert_denied(response, name)
        assert response.status_code != 200
    assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.FREE
    assert (
        call(actors(gate)["admin"][0], "patch", f"/slots/{gate.slot.pk}", body).status_code == 200
    )


def test_unknown_ids_look_like_foreign_ones(gate):
    operator = client_for(gate.operator)
    ghost = uuid.uuid4()

    assert call(operator, "get", f"/parkings/{ghost}/slots").status_code == 404
    assert call(operator, "patch", f"/slots/{ghost}", {"status": "FREE"}).status_code == 404
    foreign = make_world(slots=1)
    assert call(operator, "get", f"/parkings/{foreign.lot.id}/slots").status_code == 404
    assert (
        call(operator, "patch", f"/slots/{foreign.slots[0].pk}", {"status": "FREE"}).status_code
        == 404
    )
    walk = call(
        operator,
        "post",
        "/walk-in",
        {"slot_id": str(foreign.slots[0].pk), "plate_number": "01A555BC", "vehicle_type": "CAR"},
    )
    assert walk.status_code == 404


@pytest.mark.parametrize("status", [LotStatus.SUSPENDED, LotStatus.PENDING_REVIEW])
def test_a_lot_that_is_not_active_can_be_read_and_left_but_not_entered(gate, status):
    ParkingLot.objects.filter(pk=gate.lot.pk).update(status=status)
    operator = client_for(gate.operator)
    booking = book(gate)
    walk = {"slot_id": str(gate.slot.pk), "plate_number": "01A555BC", "vehicle_type": "CAR"}

    # reading is allowed (the app must see which cars are inside) ...
    assert call(operator, "get", f"/parkings/{gate.lot.id}/slots").status_code == 200
    assert call(client_for(gate.owner), "get", f"/parkings/{gate.lot.id}/slots").status_code == 200
    listed = call(operator, "get", "/parkings").json()["results"]
    assert [row["status"] for row in listed] == [status]
    # ... but nothing new may start
    refused = call(operator, "post", "/checkin", {"qr_token": entry_token(booking)})
    assert (refused.status_code, refused.json()["code"]) == (409, "wrong_lot")
    assert call(operator, "post", "/walk-in", walk).status_code == 404
    assert (
        call(operator, "patch", f"/slots/{gate.slot.pk}", {"status": "OUT_OF_SERVICE"}).status_code
        == 404
    )
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


def test_revoked_operator_loses_access_at_once_even_with_a_live_session(gate):
    operator = client_for(gate.operator)
    assert call(operator, "get", f"/parkings/{gate.lot.id}/slots").status_code == 200

    OperatorAssignment.objects.filter(operator=gate.operator).update(revoked_at=gate.now)

    assert call(operator, "get", f"/parkings/{gate.lot.id}/slots").status_code == 404
    assert call(operator, "get", "/parkings").json()["count"] == 0
