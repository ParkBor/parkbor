"""GET /api/v1/parkings/nearby: contract, validation, permissions, robustness."""

import os
from decimal import Decimal

import pytest
from django.core.management import call_command
from rest_framework.test import APIClient

from apps.parking.throttling import NearbyThrottle
from tests.helpers import client_for, make_user
from tests.parking.nearby.conftest import ORIGIN

pytestmark = pytest.mark.django_db

URL = "/api/v1/parkings/nearby"
RESULT_KEYS = {
    "id",
    "name",
    "address",
    "location",
    "distance_m",
    "duration_s",
    "free_slots",
    "total_slots",
    "price_per_hour",
    "rating",
    "is_open",
    "score",
}


def get(user, **params):
    params = {"lat": ORIGIN[0], "lng": ORIGIN[1], **params}
    return client_for(user).get(URL, params)


class TestPermissions:
    def test_anonymous_is_401(self):
        response = APIClient().get(URL, {"lat": 41.3, "lng": 69.2})
        assert response.status_code == 401

    @pytest.mark.parametrize("role", ["DRIVER", "OPERATOR", "OWNER", "ADMIN"])
    def test_any_authenticated_role_may_search(self, role):
        assert get(make_user(role)).status_code == 200

    def test_post_not_allowed(self, driver):
        assert client_for(driver).post(URL, {}).status_code == 405


class TestContract:
    def test_response_shape_and_types(self, driver, make_nearby_lot, osrm):
        make_nearby_lot("Chorsu", 400, free=3, total=12, price="12000", rating=4.5)
        response = get(driver)
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"results", "radius_used_m", "count"}
        assert body["count"] == 1
        assert body["radius_used_m"] == 10_000  # 1 result < 3 -> climbed to the maximum
        row = body["results"][0]
        assert set(row) == RESULT_KEYS
        assert row["name"] == "Chorsu"
        assert row["address"] == "Chorsu street"
        assert isinstance(row["id"], str)
        assert set(row["location"]) == {"lat", "lng"}
        assert row["location"]["lat"] == pytest.approx(ORIGIN[0] + 400 / 111_194.93, abs=1e-6)
        assert isinstance(row["distance_m"], int)
        assert row["distance_m"] == pytest.approx(400, abs=2)
        assert isinstance(row["duration_s"], int)
        assert (row["free_slots"], row["total_slots"]) == (3, 12)
        assert row["price_per_hour"] == "12000.00"
        assert row["rating"] == 4.5
        assert row["is_open"] is True
        assert isinstance(row["score"], float)

    def test_nullable_fields_when_unknown(self, driver, make_nearby_lot):
        make_nearby_lot("bare", 400, price=None, rating=0.0)  # OSRM is down (autouse)
        row = get(driver).json()["results"][0]
        assert row["price_per_hour"] is None
        assert row["rating"] is None
        assert row["duration_s"] is None

    def test_defaults(self, driver, make_nearby_lot):
        for i in range(25):
            make_nearby_lot(f"l{i}", 50 + i * 10)
        body = get(driver).json()
        assert body["radius_used_m"] == 3000
        assert body["count"] == len(body["results"]) == 20  # default limit

    def test_all_parameters_together(self, driver, make_nearby_lot, add_slots):
        lot = make_nearby_lot("ev", 300)
        add_slots(lot, "EV", 2, price="30000")
        response = get(
            driver,
            radius=500,
            slot_type="EV",
            limit=5,
            sort="cheapest",
            only_open="true",
        )
        assert response.status_code == 200
        assert response.json()["results"][0]["price_per_hour"] == str(Decimal("30000.00"))

    def test_sort_nearest(self, driver, make_nearby_lot):
        make_nearby_lot("far", 900)
        make_nearby_lot("near", 100)
        names = [r["name"] for r in get(driver, sort="nearest").json()["results"]]
        assert names == ["near", "far"]

    def test_only_open_false_by_default_and_accepts_false(self, driver, make_nearby_lot):
        from datetime import time

        make_nearby_lot("closed", 100, open_time=time(3, 0), close_time=time(3, 1))
        assert get(driver, only_open="false").json()["count"] == 1
        assert get(driver, only_open="true").json()["count"] == 0

    def test_empty_result_is_200(self, driver):
        body = get(driver).json()
        assert body == {"results": [], "radius_used_m": 10_000, "count": 0}

    def test_boundary_values_accepted(self, driver):
        assert get(driver, lat=-90, lng=-180, radius=100, limit=1).status_code == 200
        assert get(driver, lat=90, lng=180, radius=10_000, limit=50).status_code == 200


class TestValidation:
    @pytest.mark.parametrize(
        "params",
        [
            {"lat": None},
            {"lng": None},
            {"lat": 90.0001},
            {"lat": -90.0001},
            {"lng": 180.0001},
            {"lng": -180.0001},
            {"lat": "abc"},
            {"lng": ""},
            {"lat": "nan"},
            {"lng": "inf"},
            {"lat": "-inf"},
            {"radius": 99},
            {"radius": 10_001},
            {"radius": 0},
            {"radius": -5},
            {"radius": "abc"},
            {"radius": 100.5},
            {"limit": 0},
            {"limit": 51},
            {"limit": -1},
            {"limit": "x"},
            {"sort": "random"},
            {"sort": "RECOMMENDED"},
            {"slot_type": "VIP"},
            {"slot_type": "standard"},
            {"only_open": "maybe"},
        ],
    )
    def test_invalid_input_is_400_with_detail_and_code(self, driver, params):
        query = {"lat": ORIGIN[0], "lng": ORIGIN[1], **params}
        query = {k: v for k, v in query.items() if v is not None}
        response = client_for(driver).get(URL, query)
        assert response.status_code == 400
        body = response.json()
        assert set(body) == {"detail", "code"}
        assert body["code"] == "validation_error"
        assert isinstance(body["detail"], str) and body["detail"]

    def test_error_names_the_offending_parameter(self, driver):
        response = get(driver, radius=5)
        assert "radius" in response.json()["detail"]

    def test_sql_and_special_characters_are_just_invalid(self, driver):
        response = get(driver, slot_type="EV'; DROP TABLE parking_lot;--")
        assert response.status_code == 400
        assert get(driver, sort="‮\U0001f697").status_code == 400

    def test_unknown_params_are_ignored(self, driver):
        assert get(driver, foo="bar").status_code == 200


class TestRobustness:
    def test_osrm_down_never_500(self, driver, make_nearby_lot):
        make_nearby_lot("a", 100)
        response = get(driver)
        assert response.status_code == 200
        assert response.json()["results"][0]["duration_s"] is None

    def test_redis_down_never_500(self, driver, make_nearby_lot):
        import fakeredis

        from apps.core import redis_client

        class Broken(fakeredis.FakeRedis):
            def get(self, *a, **k):
                raise redis_client.redis.ConnectionError("down")

            def set(self, *a, **k):
                raise redis_client.redis.ConnectionError("down")

        redis_client.set_redis_client(Broken(decode_responses=True))
        make_nearby_lot("a", 100)
        assert get(driver).status_code == 200

    def test_query_count_is_constant(self, driver, make_nearby_lot, django_assert_max_num_queries):
        for i in range(20):
            make_nearby_lot(f"l{i}", 50 + i * 20)
        with django_assert_max_num_queries(6):
            assert get(driver).json()["count"] == 20

    def test_throttled_after_limit(self, driver, monkeypatch):
        monkeypatch.setitem(NearbyThrottle.THROTTLE_RATES, "nearby", "2/min")
        assert get(driver).status_code == 200
        assert get(driver).status_code == 200
        assert get(driver).status_code == 429

    def test_throttle_has_default_rate_configured(self, settings):
        assert "nearby" in settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]


class TestOpenApiSchema:
    def test_schema_generation_has_no_warnings(self):
        call_command("spectacular", "--fail-on-warn", "--file", os.devnull)

    def test_nearby_documented_with_all_parameters(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        operation = schema["paths"]["/api/v1/parkings/nearby"]["get"]
        params = {p["name"] for p in operation["parameters"]}
        assert params == {"lat", "lng", "radius", "slot_type", "limit", "sort", "only_open"}
        assert {"200", "400", "401", "429"} <= set(operation["responses"])
