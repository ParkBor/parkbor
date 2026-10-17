"""Service-area and distance limits for /routes (and for the straight-line fallback)."""

import pytest
from django.core.exceptions import ImproperlyConfigured

from apps.routing import limits

TASHKENT = (41.3113, 69.2743)
SAMARKAND = (39.6542, 66.9597)
MOSCOW = (55.7558, 37.6173)


class TestParseBbox:
    def test_parses_lat_min_lat_max_lng_min_lng_max(self):
        assert limits.parse_bbox("36.5,46.0,55.5,74.5") == (36.5, 46.0, 55.5, 74.5)

    def test_whitespace_is_tolerated(self):
        assert limits.parse_bbox(" 1, 2 ,3, 4 ") == (1.0, 2.0, 3.0, 4.0)

    @pytest.mark.parametrize(
        "raw",
        ["", "1,2,3", "1,2,3,4,5", "a,b,c,d", "46,36,55,74", "36,46,74,55", "-91,46,55,74",
         "36,46,-181,74", "36,91,55,74", "nan,46,55,74", "36,46,55,inf", "36,46,55,181"],
    )  # fmt: skip
    def test_invalid_values_fail_startup_without_echoing_them(self, raw):
        with pytest.raises(ImproperlyConfigured) as info:
            limits.parse_bbox(raw)
        assert raw not in str(info.value) or raw == ""


class TestAllowed:
    def test_defaults_cover_uzbekistan_and_reject_moscow(self):
        assert limits.route_allowed(TASHKENT, SAMARKAND)
        assert not limits.route_allowed(TASHKENT, MOSCOW)
        assert not limits.route_allowed(MOSCOW, TASHKENT)

    def test_bbox_edges_are_inside(self, settings):
        settings.ROUTING_BBOX = (10.0, 20.0, 30.0, 40.0)
        settings.ROUTING_MAX_STRAIGHT_KM = 5000
        assert limits.route_allowed((10.0, 30.0), (20.0, 40.0))
        assert not limits.route_allowed((9.99, 30.0), (20.0, 40.0))
        assert not limits.route_allowed((10.0, 30.0), (20.0, 40.01))

    def test_distance_limit(self, settings):
        settings.ROUTING_MAX_STRAIGHT_KM = 100
        assert not limits.route_allowed(TASHKENT, SAMARKAND)  # ~270 km
        settings.ROUTING_MAX_STRAIGHT_KM = 400
        assert limits.route_allowed(TASHKENT, SAMARKAND)

    def test_identical_points_are_allowed(self):
        assert limits.route_allowed(TASHKENT, TASHKENT)

    def test_defaults(self, settings):
        assert settings.ROUTING_MAX_STRAIGHT_KM == 2000
        assert settings.ROUTING_BBOX == (36.5, 46.0, 55.5, 74.5)
        assert settings.ROUTING_FULL_OVERVIEW_MAX_KM == 100
