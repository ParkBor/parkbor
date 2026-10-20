"""GET /api/v1/parkings/{id}: public facts of one ACTIVE lot for drivers."""

import uuid

import pytest
from rest_framework.test import APIClient

from apps.parking.models import ParkingLot, Slot, Tariff
from tests.adminops.conftest import bearer
from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.bookings.factories import make_slot, make_world
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


def url(lot):
    return f"/api/v1/parkings/{getattr(lot, 'pk', lot)}"


@pytest.fixture
def world():
    world = make_world(slots=2, price="6000")
    make_slot(world.zone, "EV")
    Tariff.objects.create(parking_lot=world.lot, slot_type="EV", price_per_hour="9000")
    Slot.objects.filter(pk=world.slots[0].pk).update(status="OCCUPIED")
    return world


def test_detail_shape_and_slot_types(world):
    response = bearer(make_user("DRIVER")).get(url(world.lot))
    assert response.status_code == 200
    data = response.data
    assert set(data) == {
        "id", "name", "address", "location", "free_slots", "total_slots", "price_per_hour",
        "rating", "is_open", "open_time", "close_time", "slot_types",
    }  # fmt: skip
    assert data["location"].keys() == {"lat", "lng"} and data["rating"] is None
    assert str(data["price_per_hour"]) == "6000.00"
    ev, standard = data["slot_types"]
    assert (ev["type"], ev["free_slots"], ev["total_slots"]) == ("EV", 1, 1)
    assert str(ev["price_per_hour"]) == "9000.00"
    assert (standard["type"], standard["free_slots"], standard["total_slots"]) == ("STANDARD", 1, 2)


def test_no_owner_or_staff_data_leaks(world):
    body = str(bearer(make_user("DRIVER")).get(url(world.lot)).data)
    assert str(world.owner.pk) not in body and "owner" not in body and "telegram" not in body


@pytest.mark.parametrize("status", ["PENDING_REVIEW", "SUSPENDED"])
def test_inactive_and_missing_lots_answer_the_same_404(world, status):
    ParkingLot.objects.filter(pk=world.lot.pk).update(status=status)
    client = bearer(make_user("DRIVER"))
    hidden = client.get(url(world.lot))
    missing = client.get(url(uuid.uuid4()))
    assert hidden.status_code == missing.status_code == 404
    assert hidden.data == missing.data


def test_rating_is_exposed_once_reviews_exist(world):
    ParkingLot.objects.filter(pk=world.lot.pk).update(rating=4.5)
    assert bearer(make_user("DRIVER")).get(url(world.lot)).data["rating"] == 4.5


def test_login_required_and_nearby_route_is_not_shadowed(world):
    assert APIClient().get(url(world.lot)).status_code == 401
    response = bearer(make_user("DRIVER")).get(
        "/api/v1/parkings/nearby", {"lat": 41.31, "lng": 69.24}
    )
    assert response.status_code == 200


def test_constant_query_count(world, django_assert_max_num_queries):
    client = bearer(make_user("DRIVER"))
    with django_assert_max_num_queries(8):
        assert client.get(url(world.lot)).status_code == 200


def test_throttled(world, monkeypatch):
    from rest_framework.throttling import SimpleRateThrottle

    rates = {**SimpleRateThrottle.THROTTLE_RATES, "parking_detail": "1/min"}
    monkeypatch.setattr(SimpleRateThrottle, "THROTTLE_RATES", rates)
    client = bearer(make_user("DRIVER"))
    assert [client.get(url(world.lot)).status_code for _ in range(2)] == [200, 429]
