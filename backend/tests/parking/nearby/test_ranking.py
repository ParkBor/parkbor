"""Pure ranking logic: is_open, min-max norm, score, sorting, radius expansion."""

from datetime import UTC, datetime, time
from decimal import Decimal

import pytest

from apps.parking.ranking import (
    MAX_RADIUS_M,
    MIN_RESULTS,
    NearbyLot,
    NearbyResult,
    compute_scores,
    expansion_steps,
    is_open_at,
    is_open_now,
    min_max_norm,
    scoring_metric,
    sort_results,
)


def lot(id_="a", *, free=5, total=10, price="10000", rating=None):
    return NearbyLot(
        id=id_,
        name=id_,
        address="addr",
        lat=41.3,
        lng=69.2,
        free_slots=free,
        total_slots=total,
        price_per_hour=None if price is None else Decimal(price),
        rating=rating,
        open_time=None,
        close_time=None,
    )


class TestIsOpenAt:
    def test_no_hours_means_always_open(self):
        assert is_open_at(None, None, time(3, 0))

    def test_half_defined_hours_count_as_open(self):
        assert is_open_at(time(8, 0), None, time(3, 0))
        assert is_open_at(None, time(8, 0), time(23, 0))

    def test_same_open_and_close_is_24h(self):
        assert is_open_at(time(0, 0), time(0, 0), time(13, 0))

    @pytest.mark.parametrize(
        ("now", "expected"),
        [
            (time(7, 59), False),
            (time(8, 0), True),  # opening instant is inclusive
            (time(12, 0), True),
            (time(21, 59), True),
            (time(22, 0), False),  # closing instant is exclusive
            (time(23, 30), False),
        ],
    )
    def test_daytime_range(self, now, expected):
        assert is_open_at(time(8, 0), time(22, 0), now) is expected

    @pytest.mark.parametrize(
        ("now", "expected"),
        [
            (time(21, 59), False),
            (time(22, 0), True),
            (time(23, 59), True),
            (time(0, 0), True),
            (time(5, 59), True),
            (time(6, 0), False),
            (time(12, 0), False),
        ],
    )
    def test_overnight_range(self, now, expected):
        assert is_open_at(time(22, 0), time(6, 0), now) is expected


class TestIsOpenNow:
    def test_uses_tashkent_time_not_utc(self):
        # 20:00 UTC == 01:00 next day in Asia/Tashkent (UTC+5)
        now = datetime(2026, 1, 10, 20, 0, tzinfo=UTC)
        assert is_open_now(time(22, 0), time(6, 0), now) is True  # 01:00 local, overnight
        assert is_open_now(time(8, 0), time(22, 0), now) is False  # 01:00 local

    def test_naive_datetime_rejected(self):
        with pytest.raises(ValueError, match="timezone-aware"):
            is_open_now(None, None, datetime(2026, 1, 10, 12, 0))  # noqa: DTZ001


class TestMinMaxNorm:
    def test_scales_to_unit_interval(self):
        assert min_max_norm([10, 20, 30]) == [0.0, 0.5, 1.0]

    def test_all_equal_is_zero(self):
        assert min_max_norm([7, 7, 7]) == [0.0, 0.0, 0.0]

    def test_single_value_is_zero(self):
        assert min_max_norm([42]) == [0.0]

    def test_empty(self):
        assert min_max_norm([]) == []

    def test_negative_values(self):
        assert min_max_norm([-1, 0, 1]) == [0.0, 0.5, 1.0]


class TestScoring:
    def test_formula_with_known_numbers(self):
        a = lot("a", free=10, total=10, price="10000", rating=5.0)
        b = lot("b", free=0, total=10, price="20000", rating=1.0)
        # a: time n=0, price n=0, fill=1-1=0, rating n=1 -> -0.1
        # b: time n=1, price n=1, fill=1-0=1, rating n=0 -> 0.5+0.2+0.2 = 0.9
        scores = compute_scores([a, b], metric=[100.0, 900.0])
        assert scores == pytest.approx([-0.1, 0.9])

    def test_everything_equal_gives_only_occupancy_term(self):
        lots = [lot("a"), lot("b")]
        assert compute_scores(lots, metric=[5.0, 5.0]) == pytest.approx([0.1, 0.1])  # 0.2*(1-0.5)

    def test_missing_price_is_treated_as_worst(self):
        cheap, none = lot("a", price="1000"), lot("b", price=None)
        s_cheap, s_none = compute_scores([cheap, none], metric=[1.0, 1.0])
        assert s_none > s_cheap

    def test_all_prices_missing_contributes_zero(self):
        scores = compute_scores([lot("a", price=None), lot("b", price=None)], metric=[1.0, 1.0])
        assert scores == pytest.approx([0.1, 0.1])

    def test_missing_rating_is_treated_as_zero(self):
        rated, unrated = lot("a", rating=4.5), lot("b", rating=None)
        s_rated, s_unrated = compute_scores([rated, unrated], metric=[1.0, 1.0])
        assert s_rated < s_unrated

    def test_zero_total_slots_does_not_divide_by_zero(self):
        scores = compute_scores([lot("a", free=0, total=0)], metric=[1.0])
        assert scores == pytest.approx([0.2])

    def test_empty_input(self):
        assert compute_scores([], metric=[]) == []

    def test_length_mismatch_rejected(self):
        with pytest.raises(ValueError, match="length"):
            compute_scores([lot("a")], metric=[1.0, 2.0])

    def test_nearer_travel_time_wins_when_other_terms_equal(self):
        a, b = lot("a"), lot("b")
        s_a, s_b = compute_scores([a, b], metric=[60.0, 600.0])
        assert s_a < s_b


class TestScoringMetric:
    def test_uses_durations_when_all_present(self):
        assert scoring_metric([100.0, 200.0], [30.0, 40.0]) == [30.0, 40.0]

    def test_falls_back_to_distance_when_any_duration_missing(self):
        assert scoring_metric([100.0, 200.0], [30.0, None]) == [100.0, 200.0]

    def test_falls_back_to_distance_when_no_durations(self):
        assert scoring_metric([100.0, 200.0], None) == [100.0, 200.0]


def result(id_, distance, *, price="10000", score=0.0, duration=None):
    return NearbyResult(
        lot=lot(id_, price=price),
        distance_m=distance,
        duration_s=duration,
        score=score,
        is_open=True,
    )


class TestSortResults:
    def test_nearest_orders_by_distance_then_id(self):
        items = [result("c", 300), result("a", 100), result("b", 100)]
        assert [r.lot.id for r in sort_results(items, "nearest")] == ["a", "b", "c"]

    def test_cheapest_orders_by_price_unpriced_last(self):
        items = [
            result("a", 100, price="30000"),
            result("b", 200, price=None),
            result("c", 300, price="10000"),
            result("d", 50, price="10000"),
        ]
        assert [r.lot.id for r in sort_results(items, "cheapest")] == ["d", "c", "a", "b"]

    def test_recommended_orders_by_score_then_distance(self):
        items = [
            result("a", 500, score=0.4),
            result("b", 900, score=0.1),
            result("c", 100, score=0.4),
        ]
        assert [r.lot.id for r in sort_results(items, "recommended")] == ["b", "c", "a"]

    def test_unknown_sort_rejected(self):
        with pytest.raises(ValueError, match="sort"):
            sort_results([], "random")

    def test_does_not_mutate_input(self):
        items = [result("b", 2), result("a", 1)]
        sort_results(items, "nearest")
        assert [r.lot.id for r in items] == ["b", "a"]


class TestExpansionSteps:
    def test_default_radius_then_wider_steps(self):
        assert expansion_steps(3000) == [3000, 5000, 10000]

    def test_small_radius_climbs_the_whole_ladder(self):
        assert expansion_steps(500) == [500, 1000, 3000, 5000, 10000]

    def test_exact_ladder_value_is_not_repeated(self):
        assert expansion_steps(1000) == [1000, 3000, 5000, 10000]

    def test_max_radius_does_not_expand(self):
        assert expansion_steps(MAX_RADIUS_M) == [MAX_RADIUS_M]

    def test_never_exceeds_max(self):
        assert max(expansion_steps(100)) == MAX_RADIUS_M

    def test_constants(self):
        assert MIN_RESULTS == 3
        assert MAX_RADIUS_M == 10_000
