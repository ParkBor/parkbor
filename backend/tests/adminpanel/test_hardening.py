"""API-level hardening: ownership, limits, roles, JWT path, query counts."""

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.parking.models import LotStatus, Slot, Zone
from tests.helpers import client_for, make_lot, make_user

pytestmark = pytest.mark.django_db

API = "/api/v1/admin"


class TestForeignObjects:
    @pytest.mark.parametrize("kind", ["zones", "slots", "tariffs"])
    def test_owner_patch_and_delete_foreign_is_404(self, owner_a, zone_b, slot_b, tariff_b, kind):
        target = {"zones": zone_b, "slots": slot_b, "tariffs": tariff_b}[kind]
        client = client_for(owner_a)
        assert client.patch(f"{API}/{kind}/{target.id}", {"floor": 2}).status_code == 404
        assert client.delete(f"{API}/{kind}/{target.id}").status_code == 404
        assert type(target).objects.filter(pk=target.pk).exists()

    def test_owner_cannot_move_zone_to_foreign_lot(self, owner_a, zone_a, lot_b):
        response = client_for(owner_a).patch(
            f"{API}/zones/{zone_a.id}", {"parking_lot": str(lot_b.id)}
        )
        assert response.status_code == 400
        zone_a.refresh_from_db()
        assert zone_a.parking_lot_id != lot_b.id

    def test_owner_cannot_move_slot_to_foreign_zone(self, owner_a, slot_a, zone_b):
        response = client_for(owner_a).patch(f"{API}/slots/{slot_a.id}", {"zone": str(zone_b.id)})
        assert response.status_code == 400

    def test_admin_cannot_move_slot_between_lots_either(self, admin_user, slot_a, zone_b):
        response = client_for(admin_user).patch(
            f"{API}/slots/{slot_a.id}", {"zone": str(zone_b.id)}
        )
        assert response.status_code == 400

    def test_filter_by_foreign_zone_looks_like_nonexistent(self, owner_a, zone_b):
        foreign = client_for(owner_a).get(f"{API}/slots", {"zone": str(zone_b.id)})
        missing = client_for(owner_a).get(
            f"{API}/slots", {"zone": "00000000-0000-0000-0000-000000000000"}
        )
        assert foreign.status_code == missing.status_code == 400

    def test_filter_by_foreign_parking_lot_looks_like_nonexistent(self, owner_a, lot_b):
        foreign = client_for(owner_a).get(f"{API}/zones", {"parking_lot": str(lot_b.id)})
        missing = client_for(owner_a).get(
            f"{API}/zones", {"parking_lot": "00000000-0000-0000-0000-000000000000"}
        )
        assert foreign.status_code == missing.status_code == 400


class TestModerationRoles:
    @pytest.mark.parametrize("role", ["OPERATOR", "DRIVER"])
    @pytest.mark.parametrize("action", ["approve", "suspend", "restore"])
    def test_other_roles_get_403(self, lot_a, role, action):
        response = client_for(make_user(role)).post(f"{API}/parkings/{lot_a.id}/{action}")
        assert response.status_code == 403
        lot_a.refresh_from_db()
        assert lot_a.status == LotStatus.PENDING_REVIEW

    def test_pending_lot_can_be_suspended(self, admin_user, lot_a):
        response = client_for(admin_user).post(f"{API}/parkings/{lot_a.id}/suspend")
        assert response.status_code == 200
        assert response.data["status"] == LotStatus.SUSPENDED

    def test_error_body_is_uniform_detail_and_code(self, admin_user, lot_a):
        response = client_for(admin_user).post(f"{API}/parkings/{lot_a.id}/restore")
        assert response.status_code == 409
        assert set(response.data) == {"detail", "code"}


class TestOwnerSlotStatus:
    @pytest.mark.parametrize("status", ["RESERVED", "OCCUPIED"])
    def test_owner_cannot_set_booking_statuses(self, owner_a, slot_a, status):
        response = client_for(owner_a).patch(f"{API}/slots/{slot_a.id}", {"status": status})
        assert response.status_code == 400
        assert "status" in response.data

    def test_owner_toggles_free_and_out_of_service(self, owner_a, slot_a):
        client = client_for(owner_a)
        assert (
            client.patch(f"{API}/slots/{slot_a.id}", {"status": "OUT_OF_SERVICE"}).status_code
            == 200
        )
        assert client.patch(f"{API}/slots/{slot_a.id}", {"status": "FREE"}).status_code == 200

    def test_owner_cannot_touch_occupied_slot_status(self, owner_a, slot_a):
        Slot.objects.filter(pk=slot_a.pk).update(status="OCCUPIED")
        response = client_for(owner_a).patch(f"{API}/slots/{slot_a.id}", {"status": "FREE"})
        assert response.status_code == 400

    def test_owner_cannot_create_slot_as_occupied(self, owner_a, zone_a):
        body = {"zone": str(zone_a.id), "code": "Q-1", "status": "OCCUPIED"}
        assert client_for(owner_a).post(f"{API}/slots", body).status_code == 400

    def test_admin_may_set_any_status(self, admin_user, slot_a):
        response = client_for(admin_user).patch(f"{API}/slots/{slot_a.id}", {"status": "OCCUPIED"})
        assert response.status_code == 200


class TestLimits:
    @pytest.mark.parametrize(
        "body",
        [
            {"prefix": "A", "start": 1, "end": 100000},
            {"prefix": "A", "start": 99999, "end": 100000},
            {"prefix": "A", "start": 1, "end": 2, "distance_to_entrance": 2**31},
            {"prefix": "A", "start": 1, "end": 2, "distance_to_entrance": 100001},
        ],
    )
    def test_bulk_bounds_never_500(self, owner_a, zone_a, body):
        response = client_for(owner_a).post(
            f"{API}/slots/bulk", {"zone": str(zone_a.id), **body}, format="json"
        )
        assert response.status_code == 400

    def test_bulk_highest_allowed_code_fits_column(self, owner_a, zone_a):
        response = client_for(owner_a).post(
            f"{API}/slots/bulk",
            {"zone": str(zone_a.id), "prefix": "ABCDEFGHIJ", "start": 99999, "end": 99999},
            format="json",
        )
        assert response.status_code == 201
        assert response.data["codes"] == ["ABCDEFGHIJ-99999"]

    def test_slot_distance_overflow_is_400(self, owner_a, zone_a):
        body = {"zone": str(zone_a.id), "code": "D-1", "distance_to_entrance": 2**31}
        assert client_for(owner_a).post(f"{API}/slots", body).status_code == 400

    def test_page_size_is_really_capped_at_100(self, admin_user, owner_a):
        from apps.core.geo import make_point
        from apps.parking.models import ParkingLot

        ParkingLot.objects.bulk_create(
            [
                ParkingLot(owner=owner_a, name=f"L{i}", address="a", location=make_point(69, 41))
                for i in range(105)
            ]
        )
        response = client_for(admin_user).get(f"{API}/parkings", {"page_size": 100000})
        assert response.status_code == 200
        assert response.data["count"] == 105
        assert len(response.data["results"]) == 100


class TestDestroy:
    def test_owner_cannot_delete_active_lot(self, admin_user, owner_a, lot_a):
        client_for(admin_user).post(f"{API}/parkings/{lot_a.id}/approve")
        response = client_for(owner_a).delete(f"{API}/parkings/{lot_a.id}")
        assert response.status_code == 409

    def test_suspended_lot_can_be_deleted_by_owner(self, admin_user, owner_a, lot_a):
        client_for(admin_user).post(f"{API}/parkings/{lot_a.id}/suspend")
        assert client_for(owner_a).delete(f"{API}/parkings/{lot_a.id}").status_code == 204


class TestReReviewApi:
    def test_owner_rename_of_active_lot_returns_to_review(self, admin_user, owner_a, lot_a):
        client_for(admin_user).post(f"{API}/parkings/{lot_a.id}/approve")
        response = client_for(owner_a).patch(f"{API}/parkings/{lot_a.id}", {"name": "Other"})
        assert response.status_code == 200
        assert response.data["status"] == LotStatus.PENDING_REVIEW


class TestRealAuthPath:
    def _bearer(self, user):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(user)}")
        return client

    def test_active_owner_with_jwt_sees_own_lot(self, owner_a, lot_a, lot_b):
        response = self._bearer(owner_a).get(f"{API}/parkings")
        assert response.status_code == 200
        assert [r["id"] for r in response.data["results"]] == [str(lot_a.id)]

    def test_deactivated_owner_with_valid_jwt_is_rejected(self, owner_a, lot_a):
        client = self._bearer(owner_a)
        owner_a.is_active = False
        owner_a.save(update_fields=["is_active"])
        assert client.get(f"{API}/parkings").status_code == 401

    def test_role_change_takes_effect_immediately(self, owner_a, lot_a):
        client = self._bearer(owner_a)
        owner_a.role = "DRIVER"
        owner_a.save(update_fields=["role"])
        assert client.get(f"{API}/parkings").status_code == 403


class TestQueryCounts:
    @pytest.mark.parametrize("endpoint", ["parkings", "zones", "slots", "tariffs"])
    def test_list_queries_do_not_grow_with_rows(self, admin_user, owner_a, endpoint):
        from apps.parking.models import Tariff

        def populate(n):
            lot = make_lot(owner_a, f"N{n}")
            for i in range(n):
                zone = Zone.objects.create(parking_lot=lot, name=f"Z{i}")
                Slot.objects.create(zone=zone, code=f"S{i}")
            types = ["STANDARD", "EV", "DISABLED", "LARGE"]
            for t in types[: min(n, 4)]:
                Tariff.objects.create(parking_lot=lot, slot_type=t, price_per_hour="1")

        client = client_for(admin_user)
        populate(1)
        with CaptureQueriesContext(connection) as small:
            client.get(f"{API}/{endpoint}")
        populate(4)
        populate(4)
        with CaptureQueriesContext(connection) as large:
            client.get(f"{API}/{endpoint}")
        assert len(large) == len(small)
