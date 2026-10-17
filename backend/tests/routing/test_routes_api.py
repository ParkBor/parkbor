"""GET /api/v1/routes: contract, validation, auth, throttle, error formats, OpenAPI."""

import pytest
from rest_framework.test import APIClient

from apps.routing import osrm_client, services
from apps.routing.osrm_client import OsrmError, RouteNotFound
from tests.helpers import client_for, make_user

pytestmark = pytest.mark.django_db

URL = "/api/v1/routes"
PARAMS = {"from_lat": 41.3113, "from_lng": 69.2743, "to_lat": 41.3275, "to_lng": 69.2817}

RAW = {
    "distance_m": 2346,
    "duration_s": 321,
    "geometry": {"type": "LineString", "coordinates": [[69.2743, 41.3113], [69.2817, 41.3275]]},
    "steps": [
        {
            "name": "Amir Temur",
            "distance": 10.0,
            "duration": 2.0,
            "location": {"lat": 41.3113, "lng": 69.2743},
            "maneuver": {"type": "turn", "modifier": "slight left"},
        }
    ],
}


@pytest.fixture
def osrm(monkeypatch):
    class Fake:
        calls = []
        error = None
        exit = None

        def __call__(self, src, dst, **kwargs):
            self.calls.append((src, dst))
            if self.error:
                raise self.error
            step = {**RAW["steps"][0], "maneuver": {**RAW["steps"][0]["maneuver"]}}
            if self.exit is not None:
                step["maneuver"]["exit"] = self.exit
            return {**RAW, "steps": [step]}

    fake = Fake()
    fake.calls = []
    monkeypatch.setattr(osrm_client, "route", fake)
    return fake


@pytest.fixture
def driver():
    return make_user("DRIVER")


def get(user, **overrides):
    params = {**PARAMS, **overrides}
    params = {k: v for k, v in params.items() if v is not None}
    return client_for(user).get(URL, params)


class TestSuccess:
    def test_contract_shape(self, driver, osrm):
        response = get(driver)
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {
            "distance_m", "duration_s", "geometry", "steps", "source", "approximate"
        }  # fmt: skip
        assert body["source"] == "osrm"
        assert body["approximate"] is False
        assert body["geometry"]["type"] == "LineString"
        step = body["steps"][0]
        assert set(step) == {
            "instruction_key", "name", "distance_m", "duration_s", "location", "maneuver"
        }  # fmt: skip
        assert step["instruction_key"] == "slight_left"
        assert step["maneuver"] == {"type": "turn", "modifier": "slight left", "exit": None}
        assert set(step["location"]) == {"lat", "lng"}

    def test_mode_defaults_to_driving(self, driver, osrm):
        assert get(driver).status_code == 200
        assert get(driver, mode="driving").status_code == 200

    def test_any_authenticated_role(self, osrm):
        for role in ("DRIVER", "OPERATOR", "OWNER", "ADMIN"):
            assert get(make_user(role)).status_code == 200

    def test_fallback_source_is_reported(self, driver, osrm):
        osrm.error = OsrmError("down", reason="circuit_open")
        body = get(driver).json()
        assert body["source"] == "fallback"
        assert body["approximate"] is True
        assert len(body["geometry"]["coordinates"]) == 2
        assert [s["instruction_key"] for s in body["steps"]] == ["depart", "arrive"]

    def test_same_start_and_destination_is_a_valid_zero_length_route(self, driver, osrm):
        response = get(driver, to_lat=PARAMS["from_lat"], to_lng=PARAMS["from_lng"])
        assert response.status_code == 200

    def test_roundabout_exit_is_exposed(self, driver, osrm):
        osrm.exit = 2
        step = get(driver).json()["steps"][0]
        assert step["maneuver"]["exit"] == 2

    def test_cache_is_shared_between_users(self, osrm):
        get(make_user("DRIVER"))
        get(make_user("DRIVER"))
        assert len(osrm.calls) == 1


class TestValidation:
    @pytest.mark.parametrize("missing", list(PARAMS))
    def test_missing_param_is_400(self, driver, osrm, missing):
        response = get(driver, **{missing: None})
        assert response.status_code == 400
        assert response.json()["code"] == "validation_error"
        assert missing in response.json()["detail"]

    @pytest.mark.parametrize(
        "field,value",
        [
            ("from_lat", 91), ("from_lat", -90.5), ("to_lat", 100),
            ("from_lng", 181), ("to_lng", -181),
            ("from_lat", "abc"), ("to_lng", ""), ("from_lng", "nan"), ("to_lat", "inf"),
            ("from_lat", "-inf"),
        ],
    )  # fmt: skip
    def test_bad_coordinate_is_400(self, driver, osrm, field, value):
        response = get(driver, **{field: value})
        assert response.status_code == 400
        assert response.json()["code"] == "validation_error"
        assert osrm.calls == []

    @pytest.mark.parametrize("mode", ["walking", "cycling", "DRIVING", "", "driving;x"])
    def test_other_modes_are_400(self, driver, osrm, mode):
        response = get(driver, mode=mode)
        assert response.status_code == 400
        assert response.json()["code"] == "validation_error"
        assert "mode" in response.json()["detail"]

    def test_world_boundary_coordinates_pass_field_validation(self, driver, osrm, settings):
        settings.ROUTING_BBOX = (-90.0, 90.0, -180.0, 180.0)
        settings.ROUTING_MAX_STRAIGHT_KM = 25_000
        response = get(driver, from_lat=90, from_lng=-180, to_lat=-90, to_lng=180)
        assert response.status_code == 200

    def test_destination_outside_the_service_area_is_route_too_far(self, driver, osrm):
        response = get(driver, to_lat=55.7558, to_lng=37.6173)  # Moscow
        assert response.status_code == 400
        assert response.json()["code"] == "route_too_far"
        assert set(response.json()) == {"detail", "code"}
        assert osrm.calls == []

    def test_start_outside_the_service_area_is_route_too_far(self, driver, osrm):
        response = get(driver, from_lat=51.5, from_lng=-0.12)
        assert response.json()["code"] == "route_too_far"

    def test_too_long_distance_is_route_too_far(self, driver, osrm, settings):
        settings.ROUTING_MAX_STRAIGHT_KM = 1
        response = get(driver)
        assert response.status_code == 400
        assert response.json()["code"] == "route_too_far"

    def test_error_body_only_has_detail_and_code(self, driver, osrm):
        assert set(get(driver, mode="x").json()) == {"detail", "code"}


class TestErrors:
    def test_no_route_is_404_and_no_fallback(self, driver, osrm):
        osrm.error = RouteNotFound()
        response = get(driver)
        assert response.status_code == 404
        assert response.json()["code"] == "route_not_found"
        assert set(response.json()) == {"detail", "code"}

    def test_routing_unavailable_is_503(self, driver, osrm, monkeypatch):
        osrm.error = OsrmError("down", reason="timeout")

        def broken(*a, **k):
            raise ArithmeticError

        monkeypatch.setattr(services, "straight_line_route", broken)
        response = get(driver)
        assert response.status_code == 503
        assert response.json()["code"] == "routing_unavailable"

    def test_unexpected_osrm_internals_never_leak(self, driver, osrm, settings):
        settings.OSRM_URL = "http://user:topsecret@osrm.internal:5000"
        osrm.error = OsrmError("boom http://user:topsecret@osrm.internal:5000", reason="transport")
        response = get(driver)
        assert "topsecret" not in response.content.decode()


class TestAuthAndThrottle:
    def test_anonymous_is_401(self):
        assert APIClient().get(URL, PARAMS).status_code == 401

    def test_post_not_allowed(self, driver):
        assert client_for(driver).post(URL, {}).status_code == 405

    def test_rate_is_60_per_minute_per_user(self, settings):
        from rest_framework.settings import api_settings

        assert api_settings.DEFAULT_THROTTLE_RATES["routes"] == "60/min"

    def test_throttled_after_limit(self, driver, osrm, monkeypatch):
        from apps.routing.throttling import RoutesThrottle

        monkeypatch.setattr(RoutesThrottle, "get_rate", lambda self: "2/min")
        assert get(driver).status_code == 200
        assert get(driver).status_code == 200
        response = get(driver)
        assert response.status_code == 429
        assert "Retry-After" in response

    def test_limit_is_per_user(self, osrm, monkeypatch):
        from apps.routing.throttling import RoutesThrottle

        monkeypatch.setattr(RoutesThrottle, "get_rate", lambda self: "1/min")
        assert get(make_user("DRIVER")).status_code == 200
        assert get(make_user("DRIVER")).status_code == 200


class TestSchema:
    def test_operation_documents_error_responses(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        operation = schema["paths"]["/api/v1/routes"]["get"]
        assert operation["operationId"] == "routes_get"
        assert {"200", "400", "401", "404", "429", "503"} <= set(operation["responses"])
        components = schema["components"]["schemas"]
        assert "approximate" in components["RouteResponse"]["properties"]
        assert "exit" in components["RouteManeuver"]["properties"]
        assert "route_too_far" in operation["description"]
        names = {p["name"] for p in operation["parameters"]}
        assert {"from_lat", "from_lng", "to_lat", "to_lng", "mode"} <= names
