"""Nearby search orchestration (selector on SQLite fallback + ranking + OSRM + cache)."""

from datetime import UTC, datetime, time
from decimal import Decimal

import fakeredis
import pytest

from apps.core import redis_client
from apps.core.geo import make_point
from apps.core.geomath import geohash_cell_radius_m, geohash_encode
from apps.parking import selectors, services
from apps.parking.models import LotStatus, SlotStatus, SlotType
from apps.parking.ranking import NearbyQuery
from tests.parking.nearby.conftest import ORIGIN, lat_offset

pytestmark = pytest.mark.django_db


def query(**kw):
    base = {
        "lat": ORIGIN[0],
        "lng": ORIGIN[1],
        "radius_m": 3000,
        "slot_type": None,
        "limit": 20,
        "sort": "recommended",
        "only_open": False,
    }
    return NearbyQuery(**{**base, **kw})


def names(result):
    return [r.lot.name for r in result.results]


class TestFiltering:
    def test_only_active_lots_with_free_slots(self, make_nearby_lot):
        make_nearby_lot("ok", 300)
        make_nearby_lot("pending", 310, status=LotStatus.PENDING_REVIEW)
        make_nearby_lot("suspended", 320, status=LotStatus.SUSPENDED)
        make_nearby_lot("full", 330, free=0)
        assert names(services.search_nearby(query(sort="nearest"))) == ["ok"]

    def test_radius_is_respected_by_actual_distance(self, make_nearby_lot):
        make_nearby_lot("in", 2900)
        make_nearby_lot("out", 3100)
        result = services.search_nearby(query(radius_m=3000, sort="nearest", limit=1))
        assert names(result) == ["in"]

    def test_ordered_by_distance_for_nearest(self, make_nearby_lot):
        for name, metres in [("c", 900), ("a", 100), ("b", 500)]:
            make_nearby_lot(name, metres)
        result = services.search_nearby(query(sort="nearest"))
        assert names(result) == ["a", "b", "c"]
        distances = [r.distance_m for r in result.results]
        assert distances == sorted(distances)
        assert distances[0] == pytest.approx(100, abs=2)

    def test_limit_applies_after_ordering(self, make_nearby_lot):
        for i in range(6):
            make_nearby_lot(f"l{i}", 100 * (i + 1))
        result = services.search_nearby(query(sort="nearest", limit=2))
        assert names(result) == ["l0", "l1"]

    def test_empty_when_nothing_in_range(self, make_nearby_lot):
        make_nearby_lot("far", 20_000)
        result = services.search_nearby(query())
        assert result.results == []
        assert result.radius_used_m == 10_000

    def test_equator_far_away_origin_returns_nothing(self, make_nearby_lot):
        make_nearby_lot("tashkent", 100)
        assert services.search_nearby(query(lat=0.0, lng=0.0)).results == []


class TestSlotType:
    def test_requires_free_slot_of_that_type_and_reports_type_counts(
        self, make_nearby_lot, add_slots
    ):
        with_ev = make_nearby_lot("with-ev", 300, price=None)
        add_slots(with_ev, SlotType.EV, 3, price="25000")
        add_slots(with_ev, SlotType.EV, 2, status=SlotStatus.OCCUPIED)
        add_slots(with_ev, SlotType.STANDARD, 4, price="9000")
        no_ev = make_nearby_lot("no-ev", 200, price="8000")
        add_slots(no_ev, SlotType.STANDARD, 5)
        ev_busy = make_nearby_lot("ev-busy", 250, price=None)
        add_slots(ev_busy, SlotType.EV, 2, status=SlotStatus.RESERVED, price="20000")

        result = services.search_nearby(query(slot_type="EV", sort="nearest"))

        assert names(result) == ["with-ev"]
        row = result.results[0].lot
        assert (row.free_slots, row.total_slots) == (3, 5)  # EV only, not the 7 free overall
        assert row.price_per_hour == Decimal("25000.00")

    def test_without_slot_type_price_is_cheapest_tariff(self, make_nearby_lot, add_slots):
        lot = make_nearby_lot("multi", 300, price="12000")
        add_slots(lot, SlotType.EV, 1, price="30000")
        add_slots(lot, SlotType.LARGE, 1, price="7000")
        result = services.search_nearby(query())
        assert result.results[0].lot.price_per_hour == Decimal("7000.00")
        assert result.results[0].lot.free_slots == lot.free_slots

    def test_lot_without_tariff_has_null_price(self, make_nearby_lot):
        make_nearby_lot("free-of-charge", 300, price=None)
        assert services.search_nearby(query()).results[0].lot.price_per_hour is None

    def test_slot_type_without_tariff_for_that_type_has_null_price(
        self, make_nearby_lot, add_slots
    ):
        lot = make_nearby_lot("std-priced", 300, price="5000")
        add_slots(lot, SlotType.DISABLED, 1)
        result = services.search_nearby(query(slot_type="DISABLED"))
        assert result.results[0].lot.price_per_hour is None


class TestRadiusExpansion:
    def test_expands_when_fewer_than_three(self, make_nearby_lot):
        make_nearby_lot("a", 500)
        make_nearby_lot("b", 3500)
        make_nearby_lot("c", 4500)
        result = services.search_nearby(query(radius_m=3000, sort="nearest"))
        assert result.radius_used_m == 5000
        assert names(result) == ["a", "b", "c"]

    def test_climbs_to_ten_km_at_most(self, make_nearby_lot):
        make_nearby_lot("a", 8000)
        result = services.search_nearby(query(radius_m=3000))
        assert result.radius_used_m == 10_000
        assert names(result) == ["a"]

    def test_does_not_expand_when_enough_results(self, make_nearby_lot):
        for i in range(3):
            make_nearby_lot(f"n{i}", 200 + i)
        make_nearby_lot("far", 4000)
        result = services.search_nearby(query(radius_m=3000))
        assert result.radius_used_m == 3000
        assert len(result.results) == 3

    def test_small_limit_lowers_the_threshold(self, make_nearby_lot):
        make_nearby_lot("a", 200)
        make_nearby_lot("far", 4000)
        result = services.search_nearby(query(radius_m=3000, limit=1))
        assert result.radius_used_m == 3000

    def test_only_open_counts_towards_threshold(self, make_nearby_lot):
        closed = {"open_time": time(8, 0), "close_time": time(9, 0)}
        for i in range(3):
            make_nearby_lot(f"closed{i}", 200 + i, **closed)
        make_nearby_lot("open-far", 4000)
        noon = datetime(2026, 5, 1, 7, 0, tzinfo=UTC)  # 12:00 Tashkent
        result = services.search_nearby(query(only_open=True), now=noon)
        assert result.radius_used_m == 10_000  # still < 3 open lots, so it climbs to the maximum
        assert names(result) == ["open-far"]


class TestOpenHours:
    def test_is_open_flag_and_filter_with_overnight_hours(self, make_nearby_lot):
        make_nearby_lot("night", 100, open_time=time(22, 0), close_time=time(6, 0))
        make_nearby_lot("day", 200, open_time=time(8, 0), close_time=time(20, 0))
        make_nearby_lot("always", 300)
        one_am = datetime(2026, 5, 1, 20, 0, tzinfo=UTC)  # 01:00 Tashkent

        everything = services.search_nearby(query(sort="nearest"), now=one_am)
        assert {r.lot.name: r.is_open for r in everything.results} == {
            "night": True,
            "day": False,
            "always": True,
        }
        only_open = services.search_nearby(query(sort="nearest", only_open=True), now=one_am)
        assert names(only_open) == ["night", "always"]


class TestOsrmTwoStage:
    def test_durations_and_candidate_count(self, make_nearby_lot, osrm):
        for i in range(10):
            make_nearby_lot(f"l{i}", 100 * (i + 1))
        result = services.search_nearby(query(limit=2, sort="nearest"))
        assert len(result.results) == 2
        assert all(isinstance(r.duration_s, int) for r in result.results)
        # one single Table request with M = 3 * limit candidates, nearest first
        assert len(osrm.calls) == 1
        origin, destinations = osrm.calls[0]
        assert origin == ORIGIN
        assert len(destinations) == 6

    def test_recommended_uses_travel_time_not_straight_line(self, make_nearby_lot, osrm):
        near_but_slow = make_nearby_lot("near-slow", 300)
        far_but_fast = make_nearby_lot("far-fast", 900)
        # nearest-first candidate order is [near_slow, far_fast]
        osrm.durations = [1800.0, 60.0]
        result = services.search_nearby(query(sort="recommended"))
        assert names(result) == ["far-fast", "near-slow"]
        assert {r.lot.name: r.duration_s for r in result.results} == {
            "near-slow": 1800,
            "far-fast": 60,
        }
        assert near_but_slow.pk and far_but_fast.pk

    def test_nearest_sort_ignores_travel_time(self, make_nearby_lot, osrm):
        make_nearby_lot("near-slow", 300)
        make_nearby_lot("far-fast", 900)
        osrm.durations = [1800.0, 60.0]
        assert names(services.search_nearby(query(sort="nearest"))) == ["near-slow", "far-fast"]

    def test_cheapest_sort(self, make_nearby_lot, osrm):
        make_nearby_lot("dear", 100, price="30000")
        make_nearby_lot("cheap", 800, price="5000")
        make_nearby_lot("none", 200, price=None)
        assert names(services.search_nearby(query(sort="cheapest"))) == ["cheap", "dear", "none"]

    def test_scores_are_present_and_recommended_is_score_ordered(self, make_nearby_lot, osrm):
        for i in range(4):
            make_nearby_lot(f"l{i}", 100 + 400 * i, free=2 + i, price=str(9000 + 1000 * i))
        result = services.search_nearby(query(sort="recommended"))
        scores = [r.score for r in result.results]
        assert all(s is not None for s in scores)
        assert scores == sorted(scores)


class TestOsrmFailSoft:
    def test_osrm_down_gives_null_durations_and_distance_based_order(self, make_nearby_lot):
        # autouse fixture makes osrm_client.table raise OsrmError
        for name, metres in [("c", 900), ("a", 100), ("b", 500)]:
            make_nearby_lot(name, metres)
        result = services.search_nearby(query(sort="recommended"))
        assert names(result) == ["a", "b", "c"]
        assert all(r.duration_s is None for r in result.results)
        assert all(r.score is not None for r in result.results)

    def test_partial_unreachable_uses_distance_for_all_scores(self, make_nearby_lot, osrm):
        make_nearby_lot("a", 100)
        make_nearby_lot("b", 500)
        osrm.durations = [None, 30.0]
        result = services.search_nearby(query(sort="recommended"))
        assert names(result) == ["a", "b"]  # distance based, not duration based
        assert {r.lot.name: r.duration_s for r in result.results} == {"a": None, "b": 30}

    def test_programming_errors_are_not_swallowed(self, make_nearby_lot, monkeypatch):
        """Only OsrmError is fail-soft; a bug must surface (with traceback), not hide."""
        from apps.routing import osrm_client

        def boom(*args, **kwargs):
            raise RuntimeError("bug")

        monkeypatch.setattr(osrm_client, "table", boom)
        make_nearby_lot("a", 100)
        with pytest.raises(RuntimeError, match="bug"):
            services.search_nearby(query())

    def test_failure_is_logged_without_url_or_message(self, make_nearby_lot, monkeypatch, caplog):
        from apps.routing import osrm_client

        def boom(*args, **kwargs):
            raise osrm_client.OsrmError("http://user:token@host/table failed")

        monkeypatch.setattr(osrm_client, "table", boom)
        make_nearby_lot("a", 100)
        with caplog.at_level("WARNING"):
            services.search_nearby(query())
        assert "token" not in caplog.text
        assert "OsrmError" in caplog.text


class TestCache:
    def test_key_format_and_ttl(self, make_nearby_lot, fake_redis):
        make_nearby_lot("a", 100)
        services.search_nearby(query(slot_type="EV", sort="cheapest", only_open=True, limit=7))
        services.search_nearby(query())
        cell = geohash_encode(*ORIGIN, 6)
        assert set(fake_redis.keys("nearby:*")) == {f"nearby:{cell}:EV", f"nearby:{cell}:any"}
        assert 0 < fake_redis.ttl(f"nearby:{cell}:any") <= 30

    def test_key_has_only_cell_and_slot_type(self, make_nearby_lot, fake_redis):
        """radius/sort/only_open/limit are applied in Python, so they are not in the key."""
        make_nearby_lot("a", 100)
        make_nearby_lot("b", 200)
        make_nearby_lot("c", 300)
        services.search_nearby(query(slot_type="EV"))  # no EV slots: empty, still cached
        for variant in (
            {"sort": "nearest"},
            {"sort": "cheapest", "limit": 5},
            {"only_open": True},
            {"radius_m": 500},
        ):
            services.search_nearby(query(**variant))
        cell = geohash_encode(*ORIGIN, 6)
        assert set(fake_redis.keys("nearby:*")) == {f"nearby:{cell}:any", f"nearby:{cell}:EV"}

    def test_radius_expansion_uses_one_database_query_set(
        self, make_nearby_lot, monkeypatch, django_assert_num_queries
    ):
        make_nearby_lot("a", 500)
        make_nearby_lot("b", 3500)
        make_nearby_lot("c", 9000)
        calls = []
        real = selectors.nearby_candidates
        monkeypatch.setattr(
            selectors, "nearby_candidates", lambda **kw: calls.append(kw) or real(**kw)
        )
        result = services.search_nearby(query(radius_m=500, sort="nearest"))
        assert result.radius_used_m == 10_000
        assert names(result) == ["a", "b", "c"]
        assert len(calls) == 1  # 500 -> 1000 -> 3000 -> 5000 -> 10000 all served from one fetch

    def test_fetch_radius_covers_max_radius_cell_and_spheroid_margin(
        self, make_nearby_lot, monkeypatch
    ):
        make_nearby_lot("a", 500)
        calls = []
        real = selectors.nearby_candidates
        monkeypatch.setattr(
            selectors, "nearby_candidates", lambda **kw: calls.append(kw) or real(**kw)
        )
        services.search_nearby(query())
        cell = geohash_encode(*ORIGIN, 6)
        assert calls[0]["radius_m"] == services.cell_fetch_radius_m(cell)
        assert calls[0]["radius_m"] >= 10_000 + geohash_cell_radius_m(cell) * 1.01 + 50
        assert calls[0]["cap"] == services.CELL_CANDIDATE_CAP == 150

    def test_cap_reached_is_not_cached_and_keeps_nearest(
        self, make_nearby_lot, monkeypatch, fake_redis, caplog
    ):
        monkeypatch.setattr(services, "CELL_CANDIDATE_CAP", 3)
        for i in range(5):
            make_nearby_lot(f"l{i}", 100 * (5 - i))
        with caplog.at_level("WARNING"):
            result = services.search_nearby(query(sort="nearest", limit=10))
        assert names(result) == ["l4", "l3", "l2"]  # the nearest 3 of 5
        assert fake_redis.keys("nearby:*") == []
        assert "cap" in caplog.text

    def test_below_cap_is_cached(self, make_nearby_lot, monkeypatch, fake_redis):
        monkeypatch.setattr(services, "CELL_CANDIDATE_CAP", 3)
        make_nearby_lot("a", 100)
        services.search_nearby(query())
        assert len(fake_redis.keys("nearby:*")) == 1

    def test_point_at_cell_edge_sees_lots_beyond_radius_from_the_centre(self, make_nearby_lot):
        from apps.core.geomath import geohash_decode

        c_lat, c_lng, lat_err, _ = geohash_decode(geohash_encode(*ORIGIN, 6))
        edge = (c_lat + lat_err * 0.99, c_lng)  # northern edge of the cell
        assert geohash_encode(*edge) == geohash_encode(*ORIGIN)
        # 2950 m north of the edge point => ~3250 m from the cell centre
        lot = make_nearby_lot("far-from-centre", 0)
        lot.__class__.objects.filter(pk=lot.pk).update(
            location=make_point(edge[1], edge[0] + lat_offset(2950))
        )
        result = services.search_nearby(
            query(lat=edge[0], lng=edge[1], radius_m=3000, limit=1, sort="nearest")
        )
        assert names(result) == ["far-from-centre"]
        assert result.radius_used_m == 3000
        assert result.results[0].distance_m == pytest.approx(2950, abs=3)

    def test_second_request_does_not_hit_the_database_for_lots(
        self, make_nearby_lot, django_assert_num_queries
    ):
        make_nearby_lot("a", 100)
        services.search_nearby(query())
        with django_assert_num_queries(0):
            again = services.search_nearby(query())
        assert names(again) == ["a"]

    def test_distance_is_recomputed_for_each_request_point_within_one_cell(self, make_nearby_lot):
        make_nearby_lot("a", 500)
        p1 = (ORIGIN[0], ORIGIN[1])
        p2 = (ORIGIN[0] + lat_offset(60), ORIGIN[1])  # same geohash cell, 60 m closer
        assert geohash_encode(*p1) == geohash_encode(*p2)
        first = services.search_nearby(query(lat=p1[0], lng=p1[1])).results[0].distance_m
        second = services.search_nearby(query(lat=p2[0], lng=p2[1])).results[0].distance_m
        assert first - second == pytest.approx(60, abs=3)

    def test_cached_candidates_cover_the_whole_cell(self, make_nearby_lot):
        # Lot is 2990 m from ORIGIN. A second point of the same cell, 40 m further south, sees it
        # at ~3030 m: outside 3000 m, found after expansion, with the true distance.
        make_nearby_lot("edge", 2990)
        assert names(services.search_nearby(query(sort="nearest", limit=1))) == ["edge"]
        p2 = (ORIGIN[0] - lat_offset(40), ORIGIN[1])
        assert geohash_encode(*p2) == geohash_encode(*ORIGIN)
        result = services.search_nearby(query(lat=p2[0], lng=p2[1], limit=1))
        assert names(result) == ["edge"]
        assert result.radius_used_m == 5000
        assert result.results[0].distance_m == pytest.approx(3030, abs=3)

    def test_cache_holds_no_user_data_and_no_distances(self, make_nearby_lot, fake_redis):
        make_nearby_lot("a", 100)
        services.search_nearby(query())
        raw = " ".join(fake_redis.get(k) for k in fake_redis.keys("nearby:*"))
        assert "distance" not in raw
        assert "user" not in raw

    def test_redis_outage_is_soft(self, make_nearby_lot):
        class Broken(fakeredis.FakeRedis):
            def get(self, *a, **k):
                raise redis_client.redis.ConnectionError("down")

            def set(self, *a, **k):
                raise redis_client.redis.ConnectionError("down")

        redis_client.set_redis_client(Broken(decode_responses=True))
        make_nearby_lot("a", 100)
        assert names(services.search_nearby(query())) == ["a"]

    def test_corrupt_cache_entry_is_ignored(self, make_nearby_lot, fake_redis):
        make_nearby_lot("a", 100)
        cell = geohash_encode(*ORIGIN, 6)
        fake_redis.set(f"nearby:{cell}:any", "{not json")
        assert names(services.search_nearby(query())) == ["a"]

    def test_nan_in_cache_entry_is_rejected(self, make_nearby_lot, fake_redis):
        make_nearby_lot("a", 100)
        cell = geohash_encode(*ORIGIN, 6)
        bad = (
            '[{"id": "x", "name": "n", "address": "a", "lat": NaN, "lng": 1.0, "free_slots": 1,'
            ' "total_slots": 1, "price_per_hour": null, "rating": null, "open_time": null,'
            ' "close_time": null}]'
        )
        fake_redis.set(f"nearby:{cell}:any", bad)
        assert names(services.search_nearby(query())) == ["a"]

    def test_unserialisable_candidates_do_not_break_the_request(self, make_nearby_lot, monkeypatch):
        from apps.parking import nearby_cache

        make_nearby_lot("a", 100)
        monkeypatch.setattr(
            nearby_cache.json, "dumps", lambda *a, **k: (_ for _ in ()).throw(TypeError("x"))
        )
        assert names(services.search_nearby(query())) == ["a"]

    def test_misconfigured_redis_is_fail_open(self, make_nearby_lot, monkeypatch):
        from django.core.exceptions import ImproperlyConfigured

        from apps.parking import nearby_cache

        def broken():
            raise ImproperlyConfigured("no REDIS_URL")

        monkeypatch.setattr(nearby_cache, "get_redis", broken)
        make_nearby_lot("a", 100)
        assert names(services.search_nearby(query())) == ["a"]

    def test_stale_entry_for_deleted_lot_does_not_break(self, make_nearby_lot):
        lot = make_nearby_lot("a", 100)
        services.search_nearby(query())
        lot.delete()
        # within the 30 s TTL the cached candidate may still be served; it must not raise
        services.search_nearby(query())


class TestSelectorFallback:
    def test_nearby_candidates_nearest_first_and_capped(self, make_nearby_lot):
        for i in range(5):
            make_nearby_lot(f"l{i}", 100 * (5 - i))
        got = selectors.nearby_candidates(
            lat=ORIGIN[0], lng=ORIGIN[1], radius_m=3000, slot_type=None, cap=3
        )
        assert [c.name for c in got] == ["l4", "l3", "l2"]

    def test_rating_zero_is_reported_as_none(self, make_nearby_lot):
        make_nearby_lot("unrated", 100, rating=0.0)
        make_nearby_lot("rated", 200, rating=4.5)
        got = selectors.nearby_candidates(
            lat=ORIGIN[0], lng=ORIGIN[1], radius_m=3000, slot_type=None, cap=10
        )
        assert [c.rating for c in got] == [None, 4.5]

    def test_knn_expression_compiles_to_the_distance_operator(self):
        sql = selectors.knn_order_sql(ORIGIN[0], ORIGIN[1])
        assert "<->" in sql
        assert "ST_GeogFromText" in sql
