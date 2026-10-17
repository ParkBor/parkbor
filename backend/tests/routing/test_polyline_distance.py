"""distance_to_polyline_m: rerouting helper (the app re-requests a route beyond 50 m)."""

import math

import pytest

from apps.core.geomath import distance_to_polyline_m, haversine_m

LINE = [[69.2400, 41.3000], [69.2500, 41.3000]]  # west -> east, GeoJSON [lng, lat]


def dist(lat, lng, line=LINE):
    return distance_to_polyline_m(lat, lng, line)


class TestDistanceToPolyline:
    def test_point_on_segment_is_zero(self):
        assert dist(41.3, 69.245) == pytest.approx(0, abs=0.01)

    def test_perpendicular_offset_matches_haversine(self):
        lat = 41.3 + 0.0005  # ~55.6 m north of the line
        assert dist(lat, 69.245) == pytest.approx(haversine_m(41.3, 69.245, lat, 69.245), rel=0.01)

    def test_beyond_end_uses_endpoint_distance(self):
        expected = haversine_m(41.3, 69.25, 41.3, 69.2510)
        assert dist(41.3, 69.2510) == pytest.approx(expected, rel=0.01)

    def test_before_start_uses_start_distance(self):
        expected = haversine_m(41.3, 69.24, 41.3, 69.2390)
        assert dist(41.3, 69.2390) == pytest.approx(expected, rel=0.01)

    def test_picks_nearest_segment_of_polyline(self):
        line = [[69.24, 41.30], [69.25, 41.30], [69.25, 41.31]]
        assert dist(41.305, 69.2503, line) == pytest.approx(
            haversine_m(41.305, 69.25, 41.305, 69.2503), rel=0.02
        )

    def test_single_point_polyline_is_point_distance(self):
        assert dist(41.3, 69.2, [[69.2, 41.3005]]) == pytest.approx(
            haversine_m(41.3, 69.2, 41.3005, 69.2), rel=0.01
        )

    def test_repeated_points_zero_length_segment(self):
        line = [[69.2, 41.3], [69.2, 41.3], [69.2, 41.3]]
        assert dist(41.3, 69.2, line) == pytest.approx(0, abs=0.01)

    def test_extra_coordinate_components_are_ignored(self):
        line = [[69.24, 41.30, 450.0], [69.25, 41.30, 460.0]]
        assert dist(41.3, 69.245, line) == pytest.approx(0, abs=0.01)

    def test_accepts_tuples(self):
        assert dist(41.3, 69.245, [(69.24, 41.3), (69.25, 41.3)]) == pytest.approx(0, abs=0.01)

    def test_antimeridian_crossing_segment(self):
        line = [[179.999, 10.0], [-179.999, 10.0]]
        assert dist(10.0, 180.0, line) == pytest.approx(0, abs=0.5)

    def test_antimeridian_segment_is_far_from_a_point_on_the_other_side_of_the_globe(self):
        line = [[179.0, 10.0], [-179.0, 10.0]]  # 2 degrees long, around 180
        assert dist(10.0, 0.0, line) > 19_000_000  # roughly half the globe away, not ~0

    def test_antimeridian_segment_seen_from_the_western_side(self):
        line = [[179.0, 10.0], [-179.0, 10.0]]
        assert dist(10.0, -179.5, line) == pytest.approx(0, abs=0.5)

    def test_antimeridian_polyline_with_more_points(self):
        line = [[179.5, 10.0], [180.0, 10.0], [-179.5, 10.0], [-179.0, 10.0]]
        assert dist(10.0, -179.25, line) == pytest.approx(0, abs=0.5)
        assert dist(10.0, 179.75, line) == pytest.approx(0, abs=0.5)

    def test_huge_integers_raise_value_error_not_overflow(self):
        with pytest.raises(ValueError):
            dist(10**400, 0)
        with pytest.raises(ValueError):
            dist(1, 1, [[10**400, 1.0], [1.0, 1.0]])

    def test_near_pole_stays_finite(self):
        assert math.isfinite(dist(89.9999, 10.0, [[0.0, 89.9999], [90.0, 89.9999]]))

    def test_large_polyline(self):
        line = [[69.0 + i * 1e-5, 41.0 + (i % 7) * 1e-5] for i in range(20_000)]
        assert dist(41.0, 69.1, line) >= 0

    @pytest.mark.parametrize(
        "lat,lng", [(91, 0), (-91, 0), (0, 181), (0, -181), (math.nan, 0), (0, math.inf)]
    )
    def test_invalid_query_point_raises(self, lat, lng):
        with pytest.raises(ValueError):
            dist(lat, lng)

    @pytest.mark.parametrize(
        "line",
        [[], None, "abc", [[1.0]], [[math.nan, 1.0]], [[200.0, 1.0]], [[1.0, 95.0]], [["a", "b"]]],
    )
    def test_invalid_polyline_raises(self, line):
        with pytest.raises(ValueError):
            dist(41.3, 69.2, line)

    def test_bool_coordinate_rejected(self):
        with pytest.raises(ValueError):
            dist(41.3, 69.2, [[True, False], [1.0, 1.0]])
