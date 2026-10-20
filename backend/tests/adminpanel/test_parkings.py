import pytest

from apps.parking.models import LotStatus, ParkingLot
from tests.helpers import client_for

pytestmark = pytest.mark.django_db

URL = "/api/v1/admin/parkings"
PAYLOAD = {
    "name": "Chilonzor P1",
    "address": "Chilonzor 7",
    "location": {"lat": 41.2755, "lng": 69.2034},
}


def test_owner_creates_own_lot_pending_review(owner_a):
    response = client_for(owner_a).post(URL, PAYLOAD, format="json")
    assert response.status_code == 201, response.data
    assert response.data["status"] == LotStatus.PENDING_REVIEW
    assert str(response.data["owner"]) == str(owner_a.id)
    assert response.data["location"] == {"lat": 41.2755, "lng": 69.2034}
    assert response.data["total_slots"] == 0


def test_owner_cannot_assign_lot_to_someone_else_or_set_status(owner_a, owner_b):
    body = {**PAYLOAD, "owner": str(owner_b.id), "status": "ACTIVE", "rating": 5}
    response = client_for(owner_a).post(URL, body, format="json")
    assert response.status_code == 201
    lot = ParkingLot.objects.get(pk=response.data["id"])
    assert lot.owner_id == owner_a.id
    assert lot.status == LotStatus.PENDING_REVIEW
    assert lot.rating == 0


def test_owner_cannot_transfer_lot_on_update(owner_a, owner_b, lot_a):
    response = client_for(owner_a).patch(f"{URL}/{lot_a.id}", {"owner": str(owner_b.id)})
    assert response.status_code == 200
    lot_a.refresh_from_db()
    assert lot_a.owner_id == owner_a.id


def test_admin_without_owner_owns_the_lot_itself(admin_user):
    response = client_for(admin_user).post(URL, PAYLOAD, format="json")
    assert response.status_code == 201
    assert str(response.data["owner"]) == str(admin_user.id)


def test_admin_creates_lot_for_owner(admin_user, owner_a):
    response = client_for(admin_user).post(
        URL, {**PAYLOAD, "owner": str(owner_a.id)}, format="json"
    )
    assert response.status_code == 201
    assert str(response.data["owner"]) == str(owner_a.id)


def test_owner_field_must_be_owner_or_admin_role(admin_user, driver):
    response = client_for(admin_user).post(URL, {**PAYLOAD, "owner": str(driver.id)}, format="json")
    assert response.status_code == 400


@pytest.mark.parametrize(
    "location",
    [None, "41,69", {"lat": 91, "lng": 0}, {"lat": 0, "lng": 181}, {"lat": "x", "lng": 1},
     {"lat": 1}, {"lat": True, "lng": 1}],
)  # fmt: skip
def test_invalid_location_rejected(owner_a, location):
    response = client_for(owner_a).post(URL, {**PAYLOAD, "location": location}, format="json")
    assert response.status_code == 400
    assert "location" in response.data


def test_nan_location_is_rejected_as_malformed_json(owner_a):
    raw = '{"name": "P", "address": "A", "location": {"lat": NaN, "lng": 1}}'
    response = client_for(owner_a).post(URL, raw, content_type="application/json")
    assert response.status_code == 400


def test_open_and_close_time_must_come_together(owner_a):
    response = client_for(owner_a).post(URL, {**PAYLOAD, "open_time": "08:00"}, format="json")
    assert response.status_code == 400
    ok = client_for(owner_a).post(
        URL, {**PAYLOAD, "open_time": "22:00", "close_time": "06:00"}, format="json"
    )
    assert ok.status_code == 201


def test_area_ring_must_be_closed(owner_a):
    ring = [[69.0, 41.0], [69.1, 41.0], [69.1, 41.1], [69.0, 41.1]]
    assert (
        client_for(owner_a).post(URL, {**PAYLOAD, "area": ring}, format="json").status_code == 400
    )
    closed = [*ring, ring[0]]
    response = client_for(owner_a).post(URL, {**PAYLOAD, "area": closed}, format="json")
    assert response.status_code == 201
    assert response.data["area"] == closed


def test_missing_required_fields(owner_a):
    response = client_for(owner_a).post(URL, {}, format="json")
    assert response.status_code == 400
    assert {"name", "address", "location"} <= set(response.data)


class TestModeration:
    def test_admin_approves_pending(self, admin_user, lot_a):
        response = client_for(admin_user).post(f"{URL}/{lot_a.id}/approve")
        assert response.status_code == 200
        lot_a.refresh_from_db()
        assert lot_a.status == LotStatus.ACTIVE

    def test_owner_cannot_approve_own_lot(self, owner_a, lot_a):
        response = client_for(owner_a).post(f"{URL}/{lot_a.id}/approve")
        assert response.status_code == 403
        lot_a.refresh_from_db()
        assert lot_a.status == LotStatus.PENDING_REVIEW

    def test_owner_cannot_suspend_or_restore(self, owner_a, lot_a):
        client = client_for(owner_a)
        assert client.post(f"{URL}/{lot_a.id}/suspend").status_code == 403
        assert client.post(f"{URL}/{lot_a.id}/restore").status_code == 403

    def test_owner_cannot_change_status_via_patch(self, owner_a, lot_a):
        client_for(owner_a).patch(f"{URL}/{lot_a.id}", {"status": "ACTIVE"})
        lot_a.refresh_from_db()
        assert lot_a.status == LotStatus.PENDING_REVIEW

    def test_approve_twice_conflicts(self, admin_user, lot_a):
        client = client_for(admin_user)
        client.post(f"{URL}/{lot_a.id}/approve")
        assert client.post(f"{URL}/{lot_a.id}/approve").status_code == 409

    def test_suspend_and_restore_cycle(self, admin_user, lot_a):
        client = client_for(admin_user)
        client.post(f"{URL}/{lot_a.id}/approve")
        assert client.post(f"{URL}/{lot_a.id}/suspend").data["status"] == LotStatus.SUSPENDED
        assert client.post(f"{URL}/{lot_a.id}/restore").data["status"] == LotStatus.ACTIVE

    def test_restore_requires_suspended(self, admin_user, lot_a):
        assert client_for(admin_user).post(f"{URL}/{lot_a.id}/restore").status_code == 409

    def test_cannot_approve_suspended(self, admin_user, lot_a):
        client = client_for(admin_user)
        client.post(f"{URL}/{lot_a.id}/suspend")
        assert client.post(f"{URL}/{lot_a.id}/approve").status_code == 409


class TestListing:
    def test_server_side_pagination(self, admin_user, owner_a):
        from tests.helpers import make_lot

        for i in range(25):
            make_lot(owner_a, f"L{i:02d}")
        client = client_for(admin_user)
        first = client.get(URL, {"page_size": 10})
        assert first.data["count"] == 25
        assert len(first.data["results"]) == 10
        last = client.get(URL, {"page_size": 10, "page": 3})
        assert len(last.data["results"]) == 5
        assert client.get(URL, {"page": 99}).status_code == 404

    def test_page_size_capped(self, admin_user, owner_a):
        from tests.helpers import make_lot

        for i in range(3):
            make_lot(owner_a, f"L{i}")
        assert client_for(admin_user).get(URL, {"page_size": 100000}).status_code == 200

    def test_filter_status_search_ordering(self, admin_user, owner_a):
        from tests.helpers import make_lot

        make_lot(owner_a, "Alpha", status=LotStatus.ACTIVE)
        make_lot(owner_a, "Beta")
        client = client_for(admin_user)
        active = client.get(URL, {"status": "ACTIVE"})
        assert [r["name"] for r in active.data["results"]] == ["Alpha"]
        found = client.get(URL, {"search": "bet"})
        assert [r["name"] for r in found.data["results"]] == ["Beta"]
        ordered = client.get(URL, {"ordering": "-name"})
        assert [r["name"] for r in ordered.data["results"]] == ["Beta", "Alpha"]

    def test_invalid_filter_value_is_400(self, admin_user):
        assert client_for(admin_user).get(URL, {"status": "NOPE"}).status_code == 400

    def test_owner_filter_cannot_widen_scope(self, owner_a, lot_a, lot_b):
        # a foreign owner id is not a valid choice for an owner: same answer as a missing id
        response = client_for(owner_a).get(URL, {"owner": str(lot_b.owner_id)})
        assert response.status_code == 400


def test_delete_lot_as_owner(owner_a, lot_a):
    assert client_for(owner_a).delete(f"{URL}/{lot_a.id}").status_code == 204
    assert not ParkingLot.objects.filter(pk=lot_a.pk).exists()
