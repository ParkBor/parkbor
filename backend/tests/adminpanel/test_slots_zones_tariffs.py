from decimal import Decimal

import pytest

from apps.parking.models import Slot, SlotStatus, Tariff
from tests.helpers import client_for

pytestmark = pytest.mark.django_db

SLOTS = "/api/v1/admin/slots"
ZONES = "/api/v1/admin/zones"
TARIFFS = "/api/v1/admin/tariffs"


class TestBulkSlots:
    def test_zone_a_one_to_fifty(self, owner_a, lot_a, zone_a):
        response = client_for(owner_a).post(
            f"{SLOTS}/bulk",
            {"zone": str(zone_a.id), "prefix": "A", "start": 1, "end": 50, "type": "EV"},
            format="json",
        )
        assert response.status_code == 201, response.data
        assert response.data["created"] == 50
        assert response.data["codes"][0] == "A-1"
        assert response.data["codes"][-1] == "A-50"
        assert zone_a.slots.filter(type="EV", status=SlotStatus.FREE).count() == 50
        lot_a.refresh_from_db()
        assert (lot_a.total_slots, lot_a.free_slots) == (50, 50)

    def test_duplicate_codes_rejected_atomically(self, owner_a, zone_a, slot_a):
        response = client_for(owner_a).post(
            f"{SLOTS}/bulk",
            {"zone": str(zone_a.id), "prefix": "A", "start": 1, "end": 5},
            format="json",
        )
        assert response.status_code == 409
        assert response.data["code"] == "conflict"
        assert zone_a.slots.count() == 1

    @pytest.mark.parametrize(
        "body",
        [
            {"zone": "", "prefix": "A", "start": 1, "end": 5},
            {"prefix": "", "start": 1, "end": 5},
            {"prefix": "A-", "start": 1, "end": 5},
            {"prefix": "A", "start": 0, "end": 5},
            {"prefix": "A", "start": 5, "end": 1},
            {"prefix": "A", "start": 1, "end": 501},
            {"prefix": "A", "start": 1, "end": 5, "type": "BOAT"},
            {"prefix": "A", "start": 1, "end": 5, "distance_to_entrance": -1},
        ],
    )
    def test_invalid_input(self, owner_a, zone_a, body):
        payload = {"zone": str(zone_a.id), **body}
        response = client_for(owner_a).post(f"{SLOTS}/bulk", payload, format="json")
        assert response.status_code == 400
        assert zone_a.slots.count() == 0

    def test_admin_can_bulk_any_zone(self, admin_user, zone_b):
        response = client_for(admin_user).post(
            f"{SLOTS}/bulk",
            {"zone": str(zone_b.id), "prefix": "B", "start": 1, "end": 3},
            format="json",
        )
        assert response.status_code == 201

    def test_driver_forbidden(self, driver, zone_a):
        response = client_for(driver).post(
            f"{SLOTS}/bulk", {"zone": str(zone_a.id), "prefix": "A", "start": 1, "end": 3}
        )
        assert response.status_code == 403


class TestCounters:
    def test_free_slots_follow_status_changes_and_deletes(self, owner_a, lot_a, zone_a):
        client = client_for(owner_a)
        client.post(
            f"{SLOTS}/bulk",
            {"zone": str(zone_a.id), "prefix": "A", "start": 1, "end": 4},
            format="json",
        )
        slot = zone_a.slots.get(code="A-1")
        client.patch(f"{SLOTS}/{slot.id}", {"status": "OUT_OF_SERVICE"})
        lot_a.refresh_from_db()
        assert (lot_a.total_slots, lot_a.free_slots) == (4, 3)
        client.delete(f"{SLOTS}/{slot.id}")
        lot_a.refresh_from_db()
        assert (lot_a.total_slots, lot_a.free_slots) == (3, 3)
        client.delete(f"{ZONES}/{zone_a.id}")
        lot_a.refresh_from_db()
        assert (lot_a.total_slots, lot_a.free_slots) == (0, 0)


class TestSlotCrud:
    def test_create_and_unique_code(self, owner_a, zone_a):
        client = client_for(owner_a)
        body = {
            "zone": str(zone_a.id),
            "code": "A-9",
            "type": "DISABLED",
            "distance_to_entrance": 5,
        }
        assert client.post(SLOTS, body, format="json").status_code == 201
        assert client.post(SLOTS, body, format="json").status_code == 400

    def test_zone_cannot_change(self, owner_a, zone_a, slot_a, lot_a):
        from apps.parking.models import Zone

        other = Zone.objects.create(parking_lot=lot_a, name="B")
        response = client_for(owner_a).patch(f"{SLOTS}/{slot_a.id}", {"zone": str(other.id)})
        assert response.status_code == 400

    def test_filters(self, owner_a, zone_a, lot_a):
        Slot.objects.create(zone=zone_a, code="A-1", type="EV")
        Slot.objects.create(zone=zone_a, code="A-2", type="STANDARD")
        client = client_for(owner_a)
        assert client.get(SLOTS, {"type": "EV"}).data["count"] == 1
        assert client.get(SLOTS, {"parking_lot": str(lot_a.id)}).data["count"] == 2
        assert (
            client.get(SLOTS, {"zone": str(zone_a.id), "code__icontains": "2"}).data["count"] == 1
        )


class TestZones:
    def test_create_and_duplicate_name(self, owner_a, lot_a):
        body = {"parking_lot": str(lot_a.id), "name": "North", "floor": -1}
        client = client_for(owner_a)
        assert client.post(ZONES, body, format="json").status_code == 201
        assert client.post(ZONES, body, format="json").status_code == 400

    def test_same_name_allowed_in_other_lot(self, admin_user, lot_a, zone_b):
        body = {"parking_lot": str(lot_a.id), "name": zone_b.name}
        assert client_for(admin_user).post(ZONES, body, format="json").status_code == 201


class TestTariffs:
    def test_create_with_decimal_price_and_rules(self, owner_a, lot_a):
        body = {
            "parking_lot": str(lot_a.id),
            "slot_type": "STANDARD",
            "price_per_hour": "12000.50",
            "rules": {"coefficients": [{"days": [5, 6], "coefficient": "1.5"}]},
        }
        response = client_for(owner_a).post(TARIFFS, body, format="json")
        assert response.status_code == 201, response.data
        assert response.data["price_per_hour"] == "12000.50"
        assert Tariff.objects.get().price_per_hour == Decimal("12000.50")

    @pytest.mark.parametrize("price", ["-1", "abc", "1.005", "", None, "9" * 13])
    def test_invalid_price(self, owner_a, lot_a, price):
        body = {"parking_lot": str(lot_a.id), "slot_type": "EV", "price_per_hour": price}
        response = client_for(owner_a).post(TARIFFS, body, format="json")
        assert response.status_code == 400
        assert "price_per_hour" in response.data

    def test_invalid_rules(self, owner_a, lot_a):
        body = {
            "parking_lot": str(lot_a.id),
            "slot_type": "EV",
            "price_per_hour": "1",
            "rules": {"coefficients": [{"coefficient": "99"}]},
        }
        response = client_for(owner_a).post(TARIFFS, body, format="json")
        assert response.status_code == 400
        assert "rules" in response.data

    def test_one_tariff_per_slot_type_per_lot(self, owner_a, lot_a):
        body = {"parking_lot": str(lot_a.id), "slot_type": "EV", "price_per_hour": "1"}
        client = client_for(owner_a)
        assert client.post(TARIFFS, body, format="json").status_code == 201
        assert client.post(TARIFFS, body, format="json").status_code == 400

    def test_update_price(self, admin_user, tariff_b):
        response = client_for(admin_user).patch(
            f"{TARIFFS}/{tariff_b.id}", {"price_per_hour": "7000"}
        )
        assert response.status_code == 200
        tariff_b.refresh_from_db()
        assert tariff_b.price_per_hour == Decimal("7000.00")


def test_openapi_schema_lists_admin_endpoints():
    from rest_framework.test import APIClient

    response = APIClient().get("/api/schema/", {"format": "json"})
    assert response.status_code == 200
    paths = response.json()["paths"]
    for path in (
        "/api/v1/admin/parkings",
        "/api/v1/admin/slots/bulk",
        "/api/v1/admin/tariffs/{id}",
    ):
        assert path in paths
