"""routing.services.get_route: Redis cache (fail-open), OSRM first, straight-line fallback."""

import json
import math
from types import SimpleNamespace

import pytest

from apps.core.geomath import haversine_m
from apps.routing import osrm_client, services
from apps.routing.errors import RouteTooFarError
from apps.routing.osrm_client import OsrmError, RouteNotFound
from apps.routing.steps import INSTRUCTION_KEYS

SRC = (41.311299, 69.274301)
DST = (41.327501, 69.281699)
KEY = "route:41.3113:69.2743:41.327501:69.281699"
SAMARKAND = (39.6542, 66.9597)

OSRM_RESULT = {
    "distance_m": 2346,
    "duration_s": 321,
    "geometry": {"type": "LineString", "coordinates": [[69.2743, 41.3113], [69.2817, 41.3275]]},
    "steps": [
        {
            "name": "A\x00",
            "distance": 10.4,
            "duration": 2.0,
            "location": {"lat": 41.3113, "lng": 69.2743},
            "maneuver": {"type": "depart", "modifier": None, "exit": None},
        },
        {
            "name": "B",
            "distance": 0,
            "duration": 0,
            "location": {"lat": 41.3275, "lng": 69.2817},
            "maneuver": {"type": "arrive", "modifier": None, "exit": None},
        },
    ],
}


@pytest.fixture
def osrm(monkeypatch):
    class Fake:
        calls = []
        kwargs = []
        error = None
        result = OSRM_RESULT

        def __call__(self, src, dst, **kwargs):
            self.calls.append((src, dst))
            self.kwargs.append(kwargs)
            if self.error:
                raise self.error
            return json.loads(json.dumps(self.result))

    fake = Fake()
    fake.calls, fake.kwargs = [], []
    monkeypatch.setattr(osrm_client, "route", fake)
    return fake


def good_entry(**changes):
    entry = {
        "distance_m": 1,
        "duration_s": 1,
        "steps": [],
        "source": "osrm",
        "approximate": False,
        "geometry": {"type": "LineString", "coordinates": [[1, 1], [2, 2]]},
    }
    return {**entry, **changes}


class TestCacheKey:
    def test_source_is_rounded_to_four_decimals_destination_is_exact(self):
        assert services.cache_key(SRC, DST) == KEY

    def test_nearby_start_points_share_a_key(self):
        assert services.cache_key((41.31131, 69.27431), DST) == services.cache_key(
            (41.31129, 69.27429), DST
        )

    def test_different_destinations_in_the_same_block_do_not_share_a_key(self):
        other = (DST[0] + 0.00002, DST[1])  # ~2 m away: another lot entrance
        assert services.cache_key(SRC, DST) != services.cache_key(SRC, other)

    def test_negative_zero_is_normalised(self):
        assert services.cache_key((-0.00001, 0.0), DST).startswith("route:0.0000:0.0000:")


class TestOsrmPath:
    def test_miss_calls_osrm_with_rounded_source_exact_destination_and_caches(
        self, osrm, fake_redis
    ):
        result = services.get_route(SRC, DST)
        assert osrm.calls == [((41.3113, 69.2743), (41.327501, 69.281699))]
        assert result["source"] == "osrm" and result["approximate"] is False
        assert result["distance_m"] == 2346 and result["duration_s"] == 321
        assert 0 < fake_redis.ttl(KEY) <= services.CACHE_TTL_SECONDS == 300

    def test_short_route_requests_full_overview_long_route_simplified(self, osrm):
        services.get_route(SRC, DST)
        services.get_route(SRC, SAMARKAND)
        assert osrm.kwargs[0]["overview"] == "full"
        assert osrm.kwargs[1]["overview"] == "simplified"

    def test_steps_are_simplified(self, osrm):
        steps = services.get_route(SRC, DST)["steps"]
        assert [s["instruction_key"] for s in steps] == ["depart", "arrive"]
        assert steps[0]["name"] == "A"
        assert steps[0]["distance_m"] == 10

    def test_hit_does_not_call_osrm(self, osrm, fake_redis):
        first = services.get_route(SRC, DST)
        second = services.get_route(SRC, DST)
        assert len(osrm.calls) == 1
        assert first == second

    def test_nearby_start_point_shares_the_cache_entry(self, osrm):
        services.get_route(SRC, DST)
        services.get_route((41.31131, 69.27431), DST)
        assert len(osrm.calls) == 1

    def test_reverse_direction_is_a_different_entry(self, osrm):
        services.get_route(SRC, DST)
        services.get_route(DST, SRC)
        assert len(osrm.calls) == 2

    def test_corrupt_cache_entry_is_ignored_and_overwritten(self, osrm, fake_redis):
        fake_redis.set(KEY, "{not json")
        assert services.get_route(SRC, DST)["source"] == "osrm"
        assert len(osrm.calls) == 1
        assert services.unpack(fake_redis.get(KEY))["distance_m"] == 2346

    def test_entry_without_valid_signature_is_a_miss(self, osrm, fake_redis):
        fake_redis.set(KEY, json.dumps(good_entry()))  # plain JSON, e.g. from an older version
        services.get_route(SRC, DST)
        assert len(osrm.calls) == 1

    def test_tampered_entry_is_a_miss(self, osrm, fake_redis):
        packed = services.pack(good_entry())
        fake_redis.set(KEY, packed.replace('"distance_m": 1', '"distance_m": 9'))
        assert services.get_route(SRC, DST)["distance_m"] == 2346
        assert len(osrm.calls) == 1

    def test_entry_signed_with_another_key_is_a_miss(self, osrm, fake_redis, settings):
        packed = services.pack(good_entry())
        settings.SECRET_KEY = "a-different-secret-key-for-rotation-0123456789"
        fake_redis.set(KEY, packed)
        services.get_route(SRC, DST)
        assert len(osrm.calls) == 1

    def test_valid_signature_roundtrip(self):
        assert services.unpack(services.pack(good_entry())) == good_entry()

    @pytest.mark.parametrize(
        "entry",
        [
            None,
            [],
            "x",
            {},
            good_entry(distance_m=-1),
            good_entry(distance_m=True),
            good_entry(distance_m=1.5),
            good_entry(steps="x"),
            good_entry(source="evil"),
            good_entry(source="fallback"),
            good_entry(approximate=True),
            good_entry(approximate="no"),
            good_entry(geometry={"type": "LineString", "coordinates": [[1, 1]]}),
            good_entry(geometry={"type": "Point", "coordinates": [[1, 1], [2, 2]]}),
            good_entry(geometry={"type": "LineString", "coordinates": [[1, 1], [999, 2]]}),
            good_entry(geometry={"type": "LineString", "coordinates": [[1, 1], ["a", 2]]}),
            {**good_entry(), "extra": 1},
        ],
    )
    def test_structurally_invalid_but_signed_entries_are_a_miss(self, osrm, fake_redis, entry):
        fake_redis.set(KEY, services.pack(entry))
        assert services.get_route(SRC, DST)["distance_m"] == 2346
        assert len(osrm.calls) == 1

    def test_non_finite_json_with_valid_signature_is_a_miss(self, osrm, fake_redis):
        body = '{"distance_m": NaN}'
        fake_redis.set(KEY, services.sign(body) + ":" + body)
        assert services.get_route(SRC, DST)["distance_m"] == 2346

    def test_deeply_nested_signed_json_is_a_miss(self, osrm, fake_redis):
        body = "[" * 200_000
        fake_redis.set(KEY, services.sign(body) + ":" + body)
        assert services.get_route(SRC, DST)["distance_m"] == 2346

    def test_fallback_entries_in_cache_are_not_served(self, osrm, fake_redis):
        fake_redis.set(KEY, services.pack(services.straight_line_route(SRC, DST)))
        assert services.get_route(SRC, DST)["source"] == "osrm"
        assert len(osrm.calls) == 1

    def test_route_not_found_propagates_and_is_not_cached(self, osrm, fake_redis):
        osrm.error = RouteNotFound()
        with pytest.raises(RouteNotFound):
            services.get_route(SRC, DST)
        assert fake_redis.get(KEY) is None

    def test_value_error_from_bugs_is_not_swallowed(self, osrm):
        osrm.error = ValueError("bug")
        with pytest.raises(ValueError):
            services.get_route(SRC, DST)


class TestCacheMemory:
    def big_result(self, points):
        coordinates = [[69.0 + i * 1e-6, 41.0 + i * 1e-6] for i in range(points)]
        return {**OSRM_RESULT, "geometry": {"type": "LineString", "coordinates": coordinates}}

    def test_oversized_entries_are_not_cached_but_still_returned(self, osrm, fake_redis):
        osrm.result = self.big_result(15_000)
        result = services.get_route(SRC, DST)
        assert len(result["geometry"]["coordinates"]) == 15_000
        assert fake_redis.get(KEY) is None
        assert services.MAX_CACHE_BYTES == 256 * 1024

    def test_large_entries_get_a_short_ttl(self, osrm, fake_redis):
        osrm.result = self.big_result(6_000)
        services.get_route(SRC, DST)
        assert 0 < fake_redis.ttl(KEY) <= services.LARGE_ENTRY_TTL_SECONDS == 60

    def test_small_entries_keep_the_normal_ttl(self, osrm, fake_redis):
        services.get_route(SRC, DST)
        assert fake_redis.ttl(KEY) > services.LARGE_ENTRY_TTL_SECONDS

    @pytest.mark.parametrize("reason", ["too_large", "bad_payload", "bad_json"])
    def test_unusable_osrm_answers_are_negatively_cached_briefly(self, osrm, fake_redis, reason):
        osrm.error = OsrmError("x", reason=reason)
        assert services.get_route(SRC, DST)["source"] == "fallback"
        assert 0 < fake_redis.ttl(KEY) <= services.NEGATIVE_TTL_SECONDS
        assert 30 <= services.NEGATIVE_TTL_SECONDS <= 60
        osrm.calls.clear()
        assert services.get_route(SRC, DST)["source"] == "fallback"
        assert osrm.calls == []  # served without bothering OSRM again

    @pytest.mark.parametrize("reason", ["timeout", "transport", "http_503", "circuit_open"])
    def test_outages_are_not_negatively_cached(self, osrm, fake_redis, reason):
        osrm.error = OsrmError("x", reason=reason)
        services.get_route(SRC, DST)
        assert fake_redis.get(KEY) is None


class TestRedisFailures:
    class Broken:
        def get(self, *a, **k):
            from redis.exceptions import ConnectionError as RedisConnectionError

            raise RedisConnectionError("down")

        set = get

    def test_redis_outage_is_fail_open(self, osrm):
        from apps.core import redis_client

        redis_client.set_redis_client(self.Broken())
        assert services.get_route(SRC, DST)["source"] == "osrm"

    def test_redis_construction_error_is_fail_open(self, osrm, monkeypatch):
        def boom():
            raise ValueError("bad REDIS_URL")

        monkeypatch.setattr(services, "get_redis", boom)
        assert services.get_route(SRC, DST)["source"] == "osrm"

    def test_unserialisable_result_does_not_break_the_request(self, osrm, monkeypatch):
        def bad_dumps(*args, **kwargs):
            raise TypeError("not serialisable")

        stub = SimpleNamespace(loads=json.loads, dumps=bad_dumps)
        monkeypatch.setattr(services, "json", stub)
        assert services.get_route(SRC, DST)["source"] == "osrm"


class TestLimits:
    def test_outside_the_service_area_is_route_too_far(self, osrm):
        moscow = (55.7558, 37.6173)
        with pytest.raises(RouteTooFarError):
            services.get_route(SRC, moscow)
        with pytest.raises(RouteTooFarError):
            services.get_route(moscow, DST)
        assert osrm.calls == []

    def test_too_long_straight_distance_is_route_too_far(self, osrm, settings):
        settings.ROUTING_MAX_STRAIGHT_KM = 10
        with pytest.raises(RouteTooFarError):
            services.get_route(SRC, SAMARKAND)
        assert osrm.calls == []

    def test_straight_line_fallback_obeys_the_same_limits(self, settings):
        settings.ROUTING_MAX_STRAIGHT_KM = 10
        with pytest.raises(ValueError):
            services.straight_line_route(SRC, SAMARKAND)
        with pytest.raises(ValueError):
            services.straight_line_route(SRC, (51.5, -0.12))  # intercontinental: never a fallback


class TestFallback:
    @pytest.mark.parametrize(
        "reason", ["circuit_open", "timeout", "transport", "http_503", "bad_payload", "bad_json"]
    )
    def test_osrm_errors_use_straight_line_fallback(self, osrm, reason):
        osrm.error = OsrmError("x", reason=reason)
        result = services.get_route(SRC, DST)
        assert result["source"] == "fallback" and result["approximate"] is True

    def test_fallback_is_not_cached_on_outage(self, osrm, fake_redis):
        osrm.error = OsrmError("x", reason="timeout")
        services.get_route(SRC, DST)
        assert fake_redis.get(KEY) is None
        osrm.error = None
        assert services.get_route(SRC, DST)["source"] == "osrm"

    def test_fallback_uses_exact_request_points(self, osrm):
        osrm.error = OsrmError("x", reason="timeout")
        coords = services.get_route(SRC, DST)["geometry"]["coordinates"]
        assert coords == [[SRC[1], SRC[0]], [DST[1], DST[0]]]

    def test_straight_line_shape_and_numbers(self):
        result = services.straight_line_route(SRC, DST)
        meters = haversine_m(*SRC, *DST)
        assert result["source"] == "fallback" and result["approximate"] is True
        assert result["distance_m"] == round(meters)
        assert result["duration_s"] == round(meters / (services.FALLBACK_SPEED_KMH / 3.6))
        assert services.FALLBACK_SPEED_KMH == 30
        assert result["geometry"]["type"] == "LineString"
        assert len(result["geometry"]["coordinates"]) == 2
        depart, arrive = result["steps"]
        assert depart["instruction_key"] == "depart" and arrive["instruction_key"] == "arrive"
        assert depart["distance_m"] == result["distance_m"]
        assert arrive["distance_m"] == 0 and arrive["duration_s"] == 0
        assert depart["location"] == {"lat": SRC[0], "lng": SRC[1]}
        assert arrive["location"] == {"lat": DST[0], "lng": DST[1]}
        assert depart["maneuver"] == {"type": "depart", "modifier": None, "exit": None}
        assert {s["instruction_key"] for s in result["steps"]} <= set(INSTRUCTION_KEYS)

    def test_same_point_gives_zero_length_route(self):
        result = services.straight_line_route(SRC, SRC)
        assert result["distance_m"] == 0 and result["duration_s"] == 0
        assert len(result["geometry"]["coordinates"]) == 2

    def test_fallback_failure_becomes_routing_unavailable(self, osrm, monkeypatch):
        osrm.error = OsrmError("x", reason="timeout")

        def broken(*a, **k):
            raise ArithmeticError("nope")

        monkeypatch.setattr(services, "straight_line_route", broken)
        with pytest.raises(services.RoutingUnavailable):
            services.get_route(SRC, DST)

    def test_numbers_are_finite_ints(self, settings):
        settings.ROUTING_BBOX = (-90.0, 90.0, -180.0, 180.0)
        settings.ROUTING_MAX_STRAIGHT_KM = 25_000
        result = services.straight_line_route((-89.9, -179.9), (89.9, 179.9))
        assert isinstance(result["distance_m"], int) and isinstance(result["duration_s"], int)
        assert math.isfinite(result["distance_m"])
