"""Who can see/modify what: ADMIN everything, OWNER only own lot, everyone else nothing."""

import pytest
from rest_framework.test import APIClient

from tests.helpers import client_for

pytestmark = pytest.mark.django_db

ENDPOINTS = ["parkings", "zones", "slots", "tariffs"]


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_anonymous_gets_401(endpoint):
    assert APIClient().get(f"/api/v1/admin/{endpoint}").status_code == 401


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_driver_gets_403(driver, endpoint):
    assert client_for(driver).get(f"/api/v1/admin/{endpoint}").status_code == 403


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_operator_gets_403(endpoint):
    from tests.helpers import make_user

    assert client_for(make_user("OPERATOR")).get(f"/api/v1/admin/{endpoint}").status_code == 403


def test_owner_lists_only_own_parkings(owner_a, lot_a, lot_b):
    response = client_for(owner_a).get("/api/v1/admin/parkings")
    ids = [row["id"] for row in response.data["results"]]
    assert ids == [str(lot_a.id)]


def test_admin_lists_all_parkings(admin_user, lot_a, lot_b):
    response = client_for(admin_user).get("/api/v1/admin/parkings")
    assert response.data["count"] == 2


def test_owner_cannot_read_foreign_parking(owner_a, lot_b):
    assert client_for(owner_a).get(f"/api/v1/admin/parkings/{lot_b.id}").status_code == 404


def test_owner_cannot_modify_or_delete_foreign_parking(owner_a, lot_b):
    client = client_for(owner_a)
    assert client.patch(f"/api/v1/admin/parkings/{lot_b.id}", {"name": "x"}).status_code == 404
    assert client.delete(f"/api/v1/admin/parkings/{lot_b.id}").status_code == 404


def test_owner_sees_only_own_zones_slots_tariffs(owner_a, zone_a, zone_b, slot_a, slot_b, tariff_b):
    client = client_for(owner_a)
    assert [r["id"] for r in client.get("/api/v1/admin/zones").data["results"]] == [str(zone_a.id)]
    assert [r["id"] for r in client.get("/api/v1/admin/slots").data["results"]] == [str(slot_a.id)]
    assert client.get("/api/v1/admin/tariffs").data["results"] == []
    assert client.get(f"/api/v1/admin/slots/{slot_b.id}").status_code == 404
    assert client.get(f"/api/v1/admin/tariffs/{tariff_b.id}").status_code == 404


def test_owner_cannot_create_zone_in_foreign_lot(owner_a, lot_b):
    response = client_for(owner_a).post(
        "/api/v1/admin/zones", {"parking_lot": str(lot_b.id), "name": "Z", "floor": 0}
    )
    assert response.status_code == 400
    assert "parking_lot" in response.data


def test_owner_cannot_create_tariff_or_bulk_in_foreign_lot(owner_a, lot_b, zone_b):
    client = client_for(owner_a)
    tariff = client.post(
        "/api/v1/admin/tariffs",
        {"parking_lot": str(lot_b.id), "slot_type": "EV", "price_per_hour": "1000"},
        format="json",
    )
    bulk = client.post(
        "/api/v1/admin/slots/bulk",
        {"zone": str(zone_b.id), "prefix": "A", "start": 1, "end": 3},
        format="json",
    )
    assert tariff.status_code == 400
    assert bulk.status_code == 400
    assert zone_b.slots.count() == 0
