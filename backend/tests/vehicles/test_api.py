"""/api/v1/vehicles: owner scoping, plate normalisation, limits, protection."""

from datetime import timedelta

import pytest
from django.test import override_settings

from apps.vehicles.models import Vehicle
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import client_for, make_user

pytestmark = pytest.mark.django_db

URL = "/api/v1/vehicles"


def detail(pk):
    return f"{URL}/{pk}"


@pytest.fixture
def user():
    return make_user("DRIVER")


@pytest.fixture
def api(user):
    return client_for(user)


class TestAuth:
    def test_anonymous_gets_401(self, client):
        assert client.get(URL).status_code == 401

    @pytest.mark.parametrize("role", ["DRIVER", "OPERATOR", "OWNER", "ADMIN"])
    def test_every_role_manages_its_own_vehicles(self, role):
        api = client_for(make_user(role))
        res = api.post(URL, {"plate_number": "01A123BC", "type": "CAR"}, format="json")
        assert res.status_code == 201
        assert len(api.get(URL).json()) == 1


class TestCreate:
    def test_normalises_the_plate(self, api, user):
        res = api.post(URL, {"plate_number": " 01 a 123-bc ", "type": "EV"}, format="json")
        assert res.status_code == 201
        body = res.json()
        assert body["plate_number"] == "01A123BC"
        assert body["type"] == "EV"
        assert set(body) == {"id", "plate_number", "type", "created_at"}
        assert Vehicle.objects.get(pk=body["id"]).user == user

    def test_type_defaults_to_car(self, api):
        res = api.post(URL, {"plate_number": "01A123BC"}, format="json")
        assert res.json()["type"] == "CAR"

    @pytest.mark.parametrize(
        "payload",
        [
            {},
            {"plate_number": ""},
            {"plate_number": "A1"},
            {"plate_number": "01A123BC", "type": "BIKE"},
            {"plate_number": "01А123ВС"},
            {"plate_number": None},
            {"plate_number": 123456},
        ],
    )
    def test_invalid_payload_is_400(self, api, payload):
        assert api.post(URL, payload, format="json").status_code == 400

    def test_cannot_set_user_or_id(self, api, user):
        other = make_user("DRIVER")
        res = api.post(
            URL,
            {"plate_number": "01A123BC", "user": str(other.pk), "id": "x"},
            format="json",
        )
        assert res.status_code == 201
        assert Vehicle.objects.get(pk=res.json()["id"]).user == user

    def test_duplicate_plate_for_the_same_user_is_409(self, api):
        api.post(URL, {"plate_number": "01A123BC"}, format="json")
        res = api.post(URL, {"plate_number": "01 a 123 bc"}, format="json")
        assert res.status_code == 409
        assert res.json()["code"] == "vehicle_exists"

    def test_same_plate_for_another_user_is_fine(self, api):
        other = client_for(make_user("DRIVER"))
        assert other.post(URL, {"plate_number": "01A123BC"}, format="json").status_code == 201
        assert api.post(URL, {"plate_number": "01A123BC"}, format="json").status_code == 201

    @override_settings(VEHICLES_MAX_PER_USER=2)
    def test_soft_limit_is_422(self, api):
        for n in range(2):
            assert api.post(URL, {"plate_number": f"01A12{n}BC"}, format="json").status_code == 201
        res = api.post(URL, {"plate_number": "01A129BC"}, format="json")
        assert res.status_code == 422
        assert res.json()["code"] == "vehicle_limit_reached"

    def test_default_limit_is_ten(self, api, user):
        for _ in range(10):
            make_vehicle(user)
        res = api.post(URL, {"plate_number": "01Z999ZZ"}, format="json")
        assert res.status_code == 422


class TestScoping:
    def test_list_shows_only_own_vehicles(self, api, user):
        mine = make_vehicle(user)
        make_vehicle(make_user("DRIVER"))
        ids = [v["id"] for v in api.get(URL).json()]
        assert ids == [str(mine.pk)]

    def test_foreign_vehicle_is_404_for_every_verb(self, api):
        theirs = make_vehicle(make_user("DRIVER"))
        assert api.get(detail(theirs.pk)).status_code == 404
        assert api.patch(detail(theirs.pk), {"type": "EV"}, format="json").status_code == 404
        assert (
            api.put(
                detail(theirs.pk), {"plate_number": "01A123BC", "type": "CAR"}, format="json"
            ).status_code
            == 404
        )
        assert api.delete(detail(theirs.pk)).status_code == 404
        assert Vehicle.objects.filter(pk=theirs.pk).exists()

    def test_retrieve_own(self, api, user):
        mine = make_vehicle(user, "TRUCK", "10T123AB")
        res = api.get(detail(mine.pk))
        assert res.status_code == 200
        assert res.json()["plate_number"] == "10T123AB"


class TestUpdateDelete:
    def test_patch_type_and_plate(self, api, user):
        mine = make_vehicle(user)
        res = api.patch(
            detail(mine.pk), {"type": "EV", "plate_number": "01 b 777 cd"}, format="json"
        )
        assert res.status_code == 200
        mine.refresh_from_db()
        assert (mine.type, mine.plate_number) == ("EV", "01B777CD")

    def test_patch_to_a_duplicate_plate_is_409(self, api, user):
        make_vehicle(user, plate="01A111AA")
        mine = make_vehicle(user, plate="01A222AA")
        res = api.patch(detail(mine.pk), {"plate_number": "01a111aa"}, format="json")
        assert res.status_code == 409

    def test_put_replaces(self, api, user):
        mine = make_vehicle(user)
        res = api.put(
            detail(mine.pk), {"plate_number": "01C333CC", "type": "DISABLED"}, format="json"
        )
        assert res.status_code == 200
        assert res.json()["type"] == "DISABLED"

    def test_delete_unused_vehicle(self, api, user):
        mine = make_vehicle(user)
        assert api.delete(detail(mine.pk)).status_code == 204
        assert not Vehicle.objects.filter(pk=mine.pk).exists()

    def test_put_requires_the_type(self, api, user):
        mine = make_vehicle(user, "EV")
        res = api.put(detail(mine.pk), {"plate_number": "01C333CC"}, format="json")
        assert res.status_code == 400
        assert "type" in res.json()
        mine.refresh_from_db()
        assert mine.type == "EV"  # an omitted field did not silently become a CAR

    def test_delete_vehicle_with_a_live_booking_is_409(self, api, user, now):
        world = make_world()
        mine = make_vehicle(user)
        make_booking(
            user=user,
            slot=world.slots[0],
            vehicle=mine,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
        )
        res = api.delete(detail(mine.pk))
        assert res.status_code == 409
        assert res.json()["code"] == "vehicle_in_use"

    def test_vehicle_with_history_is_archived_not_deleted(self, api, user, now):
        from apps.bookings.state import BookingStatus

        world = make_world()
        mine = make_vehicle(user, plate="01A111AA")
        booking = make_booking(
            user=user,
            slot=world.slots[0],
            vehicle=mine,
            status=BookingStatus.COMPLETED,
            start=now - timedelta(hours=3),
            end=now - timedelta(hours=2),
        )
        assert api.delete(detail(mine.pk)).status_code == 204
        mine.refresh_from_db()
        assert mine.is_archived
        assert api.get(URL).json() == []  # invisible
        assert api.get(detail(mine.pk)).status_code == 404
        booking.refresh_from_db()
        assert booking.vehicle_plate == "01A111AA"  # history keeps its plate

    def test_an_archived_vehicle_frees_its_plate_and_its_place_under_the_limit(
        self, api, user, now
    ):
        from apps.bookings.state import BookingStatus

        world = make_world()
        mine = make_vehicle(user, plate="01A111AA")
        make_booking(
            user=user,
            slot=world.slots[0],
            vehicle=mine,
            status=BookingStatus.COMPLETED,
            start=now - timedelta(hours=3),
            end=now - timedelta(hours=2),
        )
        api.delete(detail(mine.pk))
        res = api.post(URL, {"plate_number": "01a111aa"}, format="json")
        assert res.status_code == 201

    @override_settings(VEHICLES_MAX_PER_USER=1)
    def test_archived_vehicles_do_not_count_towards_the_limit(self, api, user, now):
        from apps.bookings.state import BookingStatus

        world = make_world()
        mine = make_vehicle(user)
        make_booking(
            user=user,
            slot=world.slots[0],
            vehicle=mine,
            status=BookingStatus.COMPLETED,
            start=now - timedelta(hours=3),
            end=now - timedelta(hours=2),
        )
        api.delete(detail(mine.pk))
        assert api.post(URL, {"plate_number": "01B222BB"}, format="json").status_code == 201

    @pytest.mark.parametrize("payload", [{"type": "EV"}, {"plate_number": "01Z999ZZ"}])
    def test_changing_a_vehicle_with_a_live_booking_is_409(self, api, user, now, payload):
        world = make_world()
        mine = make_vehicle(user)
        make_booking(
            user=user,
            slot=world.slots[0],
            vehicle=mine,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
        )
        res = api.patch(detail(mine.pk), payload, format="json")
        assert res.status_code == 409
        assert res.json()["code"] == "vehicle_in_use"
