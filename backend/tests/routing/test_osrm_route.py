"""OsrmClient.route: request URL, strict response validation, NoRoute, breaker, shared client."""

import copy
import math

import httpx
import pytest

from apps.routing import osrm_client
from apps.routing.osrm_client import (
    BREAKER_KEY,
    MAX_ROUTE_COORDINATES,
    OsrmClient,
    OsrmError,
    RouteNotFound,
    parse_route_response,
)

SRC = (41.3113, 69.2743)
DST = (41.3275, 69.2817)


def step(kind="turn", modifier="left", name="Amir Temur", dist=120.4, dur=30.2, loc=(69.27, 41.31)):
    maneuver = {"type": kind, "location": list(loc)}
    if modifier is not None:
        maneuver["modifier"] = modifier
    return {
        "name": name,
        "distance": dist,
        "duration": dur,
        "maneuver": maneuver,
        "geometry": {"type": "LineString", "coordinates": [list(loc), list(loc)]},
    }


GOOD = {
    "code": "Ok",
    "routes": [
        {
            "distance": 2345.6,
            "duration": 321.4,
            "geometry": {
                "type": "LineString",
                "coordinates": [[69.2743, 41.3113], [69.2817, 41.3275]],
            },
            "legs": [
                {
                    "steps": [
                        step("depart", None, "A", 10, 2, (69.2743, 41.3113)),
                        step("arrive", None, "B", 0, 0, (69.2817, 41.3275)),
                    ]
                }
            ],
        }
    ],
}


def make(handler, **kw):
    return OsrmClient(httpx.Client(transport=httpx.MockTransport(handler)), **kw)


def ok_client(payload=None, status=200):
    body = GOOD if payload is None else payload
    return make(lambda request: httpx.Response(status, json=body))


def mutated(fn):
    data = copy.deepcopy(GOOD)
    fn(data)
    return data


class TestRequest:
    def test_url_is_built_from_formatted_floats_lng_first(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            return httpx.Response(200, json=GOOD)

        make(handler).route(SRC, DST)
        assert seen["url"].endswith(
            "/route/v1/driving/69.274300,41.311300;69.281700,41.327500"
            "?overview=full&geometries=geojson&steps=true&radiuses=500;500"
        )

    def test_simplified_overview_can_be_requested(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            return httpx.Response(200, json=GOOD)

        make(handler).route(SRC, DST, overview="simplified")
        assert "overview=simplified" in seen["url"]

    def test_unknown_overview_is_rejected(self):
        with pytest.raises(ValueError):
            ok_client().route(SRC, DST, overview="full&x=1")

    def test_route_has_no_profile_argument(self):
        with pytest.raises(TypeError):
            ok_client().route(SRC, DST, "walking")

    def test_http_client_is_hardened(self):
        client = OsrmClient()
        try:
            assert client.http.trust_env is False
            assert client.http.headers["accept-encoding"] == "identity"
            assert client.http.follow_redirects is False
        finally:
            client.close()

    def test_invalid_base_url_becomes_osrm_error_without_leaking_it(self, settings):
        settings.OSRM_URL = "http://secret-host:abc"
        with pytest.raises(OsrmError) as info:
            ok_client().route(SRC, DST)
        assert "secret-host" not in f"{info.value}"
        assert info.value.reason == "bad_url"

    @pytest.mark.parametrize("point", [(91, 0), (0, 181), (math.nan, 1), (1, math.inf), (-90.1, 0)])
    def test_invalid_coordinates_raise_before_any_request(self, point):
        calls = []
        client = make(lambda r: calls.append(r) or httpx.Response(200, json=GOOD))
        with pytest.raises(ValueError):
            client.route(point, DST)
        with pytest.raises(ValueError):
            client.route(SRC, point)
        assert calls == []


class TestParsing:
    def test_valid_response_is_normalised(self):
        result = ok_client().route(SRC, DST)
        assert result["distance_m"] == 2346
        assert result["duration_s"] == 321
        assert result["geometry"] == {
            "type": "LineString",
            "coordinates": [[69.2743, 41.3113], [69.2817, 41.3275]],
        }
        assert [s["maneuver"]["type"] for s in result["steps"]] == ["depart", "arrive"]
        assert result["steps"][0]["maneuver"]["modifier"] is None
        assert result["steps"][0]["location"] == {"lat": 41.3113, "lng": 69.2743}

    def test_extra_unknown_fields_are_dropped(self):
        data = mutated(lambda d: d["routes"][0].update(weight_name="routability", evil="x"))
        assert "evil" not in parse_route_response(data)

    def test_missing_step_name_defaults_to_empty(self):
        def edit(d):
            del d["routes"][0]["legs"][0]["steps"][0]["name"]

        assert parse_route_response(mutated(edit))["steps"][0]["name"] == ""

    @pytest.mark.parametrize("code", ["NoRoute", "NoSegment"])
    def test_no_route_codes_raise_route_not_found(self, code):
        with pytest.raises(RouteNotFound):
            parse_route_response({"code": code, "message": "x"})

    def test_http_400_with_no_route_body_is_route_not_found_and_keeps_breaker_closed(
        self, fake_redis
    ):
        client = ok_client({"code": "NoRoute", "message": "Impossible route"}, status=400)
        with pytest.raises(RouteNotFound):
            client.route(SRC, DST)
        assert fake_redis.get(BREAKER_KEY) is None

    def test_http_400_with_other_code_is_bad_payload_error_without_breaker(self, fake_redis):
        client = ok_client({"code": "InvalidQuery"}, status=400)
        with pytest.raises(OsrmError) as info:
            client.route(SRC, DST)
        assert info.value.reason == "bad_code"
        assert fake_redis.get(BREAKER_KEY) is None

    def test_http_400_claiming_ok_is_rejected(self):
        with pytest.raises(OsrmError):
            ok_client(GOOD, status=400).route(SRC, DST)

    @pytest.mark.parametrize("code", ["NoRoute", "NoSegment"])
    def test_http_200_with_no_route_code_is_route_not_found(self, code, fake_redis):
        with pytest.raises(RouteNotFound):
            ok_client({"code": code}, status=200).route(SRC, DST)
        assert fake_redis.get(BREAKER_KEY) is None

    def test_sea_point_that_cannot_snap_is_route_not_found(self, fake_redis):
        body = {"code": "NoSegment", "message": "Could not find a matching segment"}
        with pytest.raises(RouteNotFound):
            ok_client(body, status=400).route(SRC, DST)

    def test_huge_integer_in_totals_is_a_clean_error(self):
        body = (
            b'{"code":"Ok","routes":[{"distance":1' + b"0" * 400 + b',"duration":1,"geometry":{},'
            b'"legs":[]}]}'
        )
        client = make(lambda r: httpx.Response(200, content=body))
        with pytest.raises(OsrmError):
            client.route(SRC, DST)

    def test_huge_integer_coordinate_is_a_clean_error(self):
        def edit(d):
            d["routes"][0]["geometry"]["coordinates"][0][0] = 10**400

        with pytest.raises(OsrmError):
            parse_route_response(mutated(edit))

    def test_deeply_nested_json_is_a_clean_error(self):
        client = make(lambda r: httpx.Response(200, content=b"[" * 200_000))
        with pytest.raises(OsrmError) as info:
            client.route(SRC, DST)
        assert info.value.reason == "bad_json"

    @pytest.mark.parametrize(
        "exit_value,expected",
        [(1, 1), (50, 50), (3, 3), (None, None), (0, None), (51, None), (-1, None),
         (True, None), (2.0, None), ("2", None)],
    )  # fmt: skip
    def test_roundabout_exit_is_validated(self, exit_value, expected):
        def edit(d):
            maneuver = d["routes"][0]["legs"][0]["steps"][0]["maneuver"]
            maneuver["exit"] = exit_value

        step_ = parse_route_response(mutated(edit))["steps"][0]
        assert step_["maneuver"]["exit"] == expected

    def test_missing_exit_is_none(self):
        assert parse_route_response(GOOD)["steps"][0]["maneuver"]["exit"] is None

    @pytest.mark.parametrize(
        "payload",
        [
            None,
            [],
            "Ok",
            {},
            {"code": "Error"},
            {"code": "Ok"},
            {"code": "Ok", "routes": []},
            {"code": "Ok", "routes": "x"},
            {"code": "Ok", "routes": [None]},
            {"code": "InvalidUrl"},
        ],
    )
    def test_malformed_top_level_raises_osrm_error(self, payload):
        with pytest.raises(OsrmError) as info:
            parse_route_response(payload)
        assert info.value.reason in {"bad_code", "bad_payload"}

    @pytest.mark.parametrize(
        "field,value",
        [
            ("distance", -1),
            ("distance", math.nan),
            ("distance", math.inf),
            ("distance", "5"),
            ("distance", True),
            ("distance", None),
            ("duration", -0.5),
            ("duration", math.nan),
            ("duration", "x"),
            ("duration", None),
        ],
    )
    def test_bad_totals_rejected(self, field, value):
        data = mutated(lambda d: d["routes"][0].__setitem__(field, value))
        with pytest.raises(OsrmError):
            parse_route_response(data)

    @pytest.mark.parametrize(
        "geometry",
        [
            None,
            "line",
            {"type": "Point", "coordinates": [1, 2]},
            {"type": "LineString"},
            {"type": "LineString", "coordinates": "x"},
            {"type": "LineString", "coordinates": []},
            {"type": "LineString", "coordinates": [[69.2, 41.3]]},
            {"type": "LineString", "coordinates": [[69.2, 41.3], [69.3]]},
            {"type": "LineString", "coordinates": [[69.2, 41.3], ["a", "b"]]},
            {"type": "LineString", "coordinates": [[69.2, 41.3], [math.nan, 41.3]]},
            {"type": "LineString", "coordinates": [[69.2, 41.3], [181, 41.3]]},
            {"type": "LineString", "coordinates": [[69.2, 41.3], [69.3, 91]]},
            {"type": "LineString", "coordinates": [[69.2, 41.3], [True, False]]},
            {"type": "LineString", "coordinates": [[69.2, 41.3], None]},
        ],
    )
    def test_bad_geometry_rejected(self, geometry):
        data = mutated(lambda d: d["routes"][0].__setitem__("geometry", geometry))
        with pytest.raises(OsrmError):
            parse_route_response(data)

    def test_coordinate_count_boundary(self):
        def with_points(n):
            line = [[69.0 + i * 1e-6, 41.0] for i in range(n)]
            return mutated(
                lambda d: d["routes"][0].__setitem__(
                    "geometry", {"type": "LineString", "coordinates": line}
                )
            )

        ok = parse_route_response(with_points(MAX_ROUTE_COORDINATES))
        assert len(ok["geometry"]["coordinates"]) == MAX_ROUTE_COORDINATES
        with pytest.raises(OsrmError):
            parse_route_response(with_points(MAX_ROUTE_COORDINATES + 1))

    def test_coordinate_cap_is_20000(self):
        assert MAX_ROUTE_COORDINATES == 20_000

    @pytest.mark.parametrize(
        "bad_step",
        [
            None,
            "x",
            {},
            {"name": "A", "distance": 1, "duration": 1},
            {"name": "A", "distance": 1, "duration": 1, "maneuver": "turn"},
            {
                "name": "A",
                "distance": -1,
                "duration": 1,
                "maneuver": {"type": "turn", "location": [1, 1]},
            },
            {
                "name": "A",
                "distance": 1,
                "duration": math.nan,
                "maneuver": {"type": "turn", "location": [1, 1]},
            },
            {
                "name": 5,
                "distance": 1,
                "duration": 1,
                "maneuver": {"type": "turn", "location": [1, 1]},
            },
            {
                "name": "A",
                "distance": 1,
                "duration": 1,
                "maneuver": {"type": 7, "location": [1, 1]},
            },
            {
                "name": "A",
                "distance": 1,
                "duration": 1,
                "maneuver": {"type": "turn", "modifier": 3, "location": [1, 1]},
            },
            {"name": "A", "distance": 1, "duration": 1, "maneuver": {"type": "turn"}},
            {
                "name": "A",
                "distance": 1,
                "duration": 1,
                "maneuver": {"type": "turn", "location": [1]},
            },
            {
                "name": "A",
                "distance": 1,
                "duration": 1,
                "maneuver": {"type": "turn", "location": [500, 1]},
            },
            {
                "name": "A",
                "distance": 1,
                "duration": 1,
                "maneuver": {"type": "turn", "location": [1, math.nan]},
            },
        ],
    )
    def test_bad_step_shape_rejected(self, bad_step):
        def edit(d):
            d["routes"][0]["legs"][0]["steps"].append(bad_step)

        with pytest.raises(OsrmError):
            parse_route_response(mutated(edit))

    @pytest.mark.parametrize("legs", [None, "x", [], [None], [{}], [{"steps": "x"}]])
    def test_bad_legs_rejected(self, legs):
        data = mutated(lambda d: d["routes"][0].__setitem__("legs", legs))
        with pytest.raises(OsrmError):
            parse_route_response(data)

    def test_too_many_raw_steps_rejected(self):
        many = [step() for _ in range(osrm_client.MAX_RAW_STEPS + 1)]
        data = mutated(lambda d: d["routes"][0]["legs"][0].__setitem__("steps", many))
        with pytest.raises(OsrmError):
            parse_route_response(data)

    def test_steps_from_all_legs_are_flattened(self):
        def edit(d):
            d["routes"][0]["legs"].append({"steps": [step("arrive", None)]})

        assert len(parse_route_response(mutated(edit))["steps"]) == 3

    def test_error_message_never_contains_the_url(self, settings):
        settings.OSRM_URL = "http://user:secret@osrm.internal:5000"
        client = make(lambda request: httpx.Response(200, json={"code": "Weird"}))
        with pytest.raises(OsrmError) as info:
            client.route(SRC, DST)
        text = f"{info.value} {info.value.reason}"
        assert "secret" not in text and "osrm.internal" not in text


class TestFailuresAndBreaker:
    def test_5xx_trips_breaker_and_next_call_skips_network(self, fake_redis):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(503)

        client = make(handler)
        for _ in range(osrm_client.BREAKER_FAILURE_THRESHOLD):
            assert fake_redis.get(BREAKER_KEY) is None  # a single slow/failed call never opens it
            with pytest.raises(OsrmError) as info:
                client.route(SRC, DST)
            assert info.value.reason == "http_503"
        assert fake_redis.get(BREAKER_KEY) is not None
        with pytest.raises(OsrmError) as info:
            client.route(SRC, DST)
        assert info.value.reason == "circuit_open"
        assert len(calls) == osrm_client.BREAKER_FAILURE_THRESHOLD

    def test_breaker_open_from_table_also_blocks_route(self, fake_redis):
        fake_redis.set(BREAKER_KEY, "1")
        with pytest.raises(OsrmError) as info:
            ok_client().route(SRC, DST)
        assert info.value.reason == "circuit_open"

    def test_transport_error_trips_breaker(self, fake_redis):
        def handler(request):
            raise httpx.ConnectError("boom")

        for _ in range(osrm_client.BREAKER_FAILURE_THRESHOLD):
            with pytest.raises(OsrmError) as info:
                make(handler).route(SRC, DST)
            assert info.value.reason == "transport"
        assert fake_redis.get(BREAKER_KEY) is not None

    def test_garbage_payload_does_not_trip_breaker(self, fake_redis):
        with pytest.raises(OsrmError):
            ok_client({"code": "Ok", "routes": []}).route(SRC, DST)
        assert fake_redis.get(BREAKER_KEY) is None

    def test_invalid_json_body(self):
        client = make(lambda r: httpx.Response(200, content=b"<html>"))
        with pytest.raises(OsrmError) as info:
            client.route(SRC, DST)
        assert info.value.reason == "bad_json"

    def test_nan_literal_in_json_is_rejected(self):
        body = b'{"code":"Ok","routes":[{"distance":NaN,"duration":1,"geometry":{},"legs":[]}]}'
        client = make(lambda r: httpx.Response(200, content=body))
        with pytest.raises(OsrmError):
            client.route(SRC, DST)

    def test_oversized_body_rejected(self):
        client = make(
            lambda r: httpx.Response(200, content=b"x" * (osrm_client.MAX_BODY_BYTES + 1))
        )
        with pytest.raises(OsrmError) as info:
            client.route(SRC, DST)
        assert info.value.reason == "too_large"

    def test_deadline_applies_to_route(self):
        now = [0.0]

        def chunks():
            for _ in range(3):
                now[0] += 2.0
                yield b" "

        client = make(lambda r: httpx.Response(200, content=chunks()), clock=lambda: now[0])
        with pytest.raises(OsrmError) as info:
            client.route(SRC, DST)
        assert info.value.reason == "timeout"

    def test_no_redirects_followed(self):
        client = make(lambda r: httpx.Response(302, headers={"location": "http://evil/"}))
        with pytest.raises(OsrmError):
            client.route(SRC, DST)


class TestSharedClient:
    def test_get_osrm_client_is_a_singleton_and_replaceable(self):
        osrm_client.set_osrm_client(None)
        first = osrm_client.get_osrm_client()
        assert osrm_client.get_osrm_client() is first
        replacement = OsrmClient()
        osrm_client.set_osrm_client(replacement)
        try:
            assert osrm_client.get_osrm_client() is replacement
        finally:
            osrm_client.set_osrm_client(None)

    def test_replacing_the_client_closes_the_old_one(self):
        old_http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
        osrm_client.set_osrm_client(OsrmClient(old_http))
        osrm_client.set_osrm_client(None)
        assert old_http.is_closed

    def test_singleton_creation_is_thread_safe(self):
        from concurrent.futures import ThreadPoolExecutor

        osrm_client.set_osrm_client(None)
        with ThreadPoolExecutor(16) as pool:
            clients = list(pool.map(lambda _: osrm_client.get_osrm_client(), range(64)))
        assert len({id(c) for c in clients}) == 1
        osrm_client.set_osrm_client(None)

    def test_http_client_is_created_once_across_threads(self):
        from concurrent.futures import ThreadPoolExecutor

        client = OsrmClient()
        with ThreadPoolExecutor(16) as pool:
            https = list(pool.map(lambda _: client.http, range(64)))
        assert len({id(h) for h in https}) == 1
        client.http.close()

    def test_module_level_table_and_route_use_the_shared_client(self):
        fake = make(lambda r: httpx.Response(200, json=GOOD))
        osrm_client.set_osrm_client(fake)
        try:
            assert osrm_client.route(SRC, DST)["distance_m"] == 2346
            table_client = make(
                lambda r: httpx.Response(200, json={"code": "Ok", "durations": [[5]]})
            )
            osrm_client.set_osrm_client(table_client)
            assert osrm_client.table(SRC, [DST]) == [5.0]
        finally:
            osrm_client.set_osrm_client(None)

    def test_module_level_functions_accept_explicit_httpx_client(self):
        http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=GOOD)))
        assert osrm_client.route(SRC, DST, client=http)["duration_s"] == 321
