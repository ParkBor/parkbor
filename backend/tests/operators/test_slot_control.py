"""PATCH /operator/slots/{id}: manual PHYSICAL status (FREE / OUT_OF_SERVICE only)."""

import logging
from datetime import timedelta

import pytest

from apps.bookings.state import BookingStatus as S
from apps.parking.models import ParkingLot, Slot, SlotStatus
from tests.helpers import client_for
from tests.operators.helpers import book

pytestmark = pytest.mark.django_db


def patch(client, slot, **body):
    return client.patch(f"/api/v1/operator/slots/{slot.pk}", body, format="json")


def status_of(slot):
    return Slot.objects.get(pk=slot.pk).status


def free_slots(gate):
    return ParkingLot.objects.get(pk=gate.lot.pk).free_slots


def test_out_of_service_and_back(gate):
    operator = client_for(gate.operator)

    out = patch(operator, gate.slot, status="OUT_OF_SERVICE")

    assert out.status_code == 200
    assert out.json() == {
        "id": str(gate.slot.pk),
        "code": gate.slot.code,
        "status": "OUT_OF_SERVICE",
        "affected_bookings": 0,
    }
    assert free_slots(gate) == 1
    back = patch(operator, gate.slot, status="FREE")
    assert (back.status_code, status_of(gate.slot), free_slots(gate)) == (200, "FREE", 2)


def test_same_status_is_a_harmless_no_op(gate):
    response = patch(client_for(gate.operator), gate.slot, status="FREE")

    assert response.status_code == 200
    assert free_slots(gate) == 2


@pytest.mark.parametrize("value", ["OCCUPIED", "RESERVED", "BROKEN", ""])
def test_occupied_and_reserved_cannot_be_set_by_hand(gate, value):
    response = patch(client_for(gate.operator), gate.slot, status=value)

    assert response.status_code == 400
    assert status_of(gate.slot) == "FREE"


def test_status_is_required(gate):
    assert patch(client_for(gate.operator), gate.slot).status_code == 400


@pytest.mark.parametrize("target", ["FREE", "OUT_OF_SERVICE"])
def test_a_slot_with_a_car_in_it_cannot_be_changed(gate, target):
    book(gate, status=S.ACTIVE, start_min=-60, end_min=60, checked_in_at=gate.now)
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)

    response = patch(client_for(gate.owner), gate.slot, status=target, force=True)

    assert (response.status_code, response.json()["code"]) == (409, "slot_in_use")
    assert status_of(gate.slot) == "OCCUPIED"


def test_overstaying_car_also_blocks_a_manual_change(gate):
    book(gate, status=S.OVERSTAY, start_min=-200, end_min=-20, checked_in_at=gate.now)
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)

    response = patch(client_for(gate.operator), gate.slot, status="FREE")

    assert response.json()["code"] == "slot_in_use"


def test_waiting_bookings_refuse_out_of_service(gate):
    book(gate, start_min=60, end_min=120)
    book(gate, start_min=180, end_min=240)

    response = patch(client_for(gate.operator), gate.slot, status="OUT_OF_SERVICE")

    assert (response.status_code, response.json()["code"]) == (409, "slot_has_bookings")
    assert "2" in response.json()["detail"]
    assert status_of(gate.slot) == "FREE"


def test_an_unpaid_hold_that_is_still_running_counts(gate):
    book(
        gate,
        status=S.PENDING_PAYMENT,
        start_min=60,
        end_min=120,
        hold_expires_at=gate.now + timedelta(minutes=5),
    )

    response = patch(client_for(gate.operator), gate.slot, status="OUT_OF_SERVICE")

    assert response.json()["code"] == "slot_has_bookings"


@pytest.mark.parametrize(
    "status", [S.EXPIRED, S.CANCELLED, S.COMPLETED, S.NO_SHOW, S.PENDING_PAYMENT]
)
def test_dead_bookings_and_lapsed_holds_do_not_count(gate, status):
    book(
        gate,
        status=status,
        start_min=60,
        end_min=120,
        hold_expires_at=gate.now - timedelta(minutes=1),
    )

    response = patch(client_for(gate.operator), gate.slot, status="OUT_OF_SERVICE")

    assert response.status_code == 200


def test_bookings_that_have_ended_do_not_count(gate):
    book(gate, status=S.CONFIRMED, start_min=-300, end_min=-100)  # in the past, not yet swept

    response = patch(client_for(gate.operator), gate.slot, status="OUT_OF_SERVICE")

    assert response.status_code == 200


def test_force_is_refused_for_an_operator(gate):
    book(gate, start_min=60, end_min=120)

    response = patch(client_for(gate.operator), gate.slot, status="OUT_OF_SERVICE", force=True)

    assert (response.status_code, response.json()["code"]) == (403, "force_not_allowed")
    assert status_of(gate.slot) == "FREE"


@pytest.mark.parametrize("who", ["owner", "admin"])
def test_force_works_for_owner_and_admin_and_leaves_the_bookings_alone(gate, who):
    from tests.helpers import make_user

    booking = book(gate, start_min=60, end_min=120)
    user = gate.owner if who == "owner" else make_user("ADMIN")

    response = patch(client_for(user), gate.slot, status="OUT_OF_SERVICE", force=True)

    assert response.status_code == 200
    assert response.json()["affected_bookings"] == 1
    assert status_of(gate.slot) == "OUT_OF_SERVICE"
    booking.refresh_from_db()
    assert booking.status == S.CONFIRMED


def test_force_without_bookings_is_harmless_for_an_operator(gate):
    response = patch(client_for(gate.operator), gate.slot, status="OUT_OF_SERVICE", force=True)

    assert response.status_code == 200


def test_a_drifted_occupied_slot_without_a_car_can_be_freed(gate):
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)

    response = patch(client_for(gate.operator), gate.slot, status="FREE")

    assert response.status_code == 200
    assert free_slots(gate) == 2


def test_change_is_audited(gate, caplog, django_capture_on_commit_callbacks):
    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        patch(client_for(gate.operator), gate.slot, status="OUT_OF_SERVICE")

    record = next(r for r in caplog.records if r.getMessage() == "audit operator.slot_status")
    assert record.audit_actor == str(gate.operator.id)
    assert record.audit_before == {"status": "FREE"}
    assert record.audit_after["status"] == "OUT_OF_SERVICE"


def test_checking_in_on_an_out_of_service_slot_is_refused_afterwards(gate):
    from apps.bookings import checkin
    from apps.core.exceptions import ApiError
    from tests.operators.helpers import entry_token

    booking = book(gate)
    patch(client_for(gate.owner), gate.slot, status="OUT_OF_SERVICE", force=True)

    with pytest.raises(ApiError) as exc:
        checkin.check_in(operator=gate.operator, token=entry_token(booking), now=gate.now)

    assert str(exc.value.detail["code"]) == "slot_out_of_service"
