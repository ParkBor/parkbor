"""Pure geo maths: Haversine and geohash (no GDAL, no DB)."""

import math

import pytest

from apps.core.geomath import (
    EARTH_RADIUS_M,
    geohash_cell_radius_m,
    geohash_decode,
    geohash_encode,
    haversine_m,
)


class TestHaversine:
    def test_same_point_is_zero(self):
        assert haversine_m(41.31, 69.24, 41.31, 69.24) == 0.0

    def test_one_degree_of_latitude(self):
        expected = math.pi * EARTH_RADIUS_M / 180
        assert haversine_m(0, 0, 1, 0) == pytest.approx(expected, abs=1)
        assert expected == pytest.approx(111_194.93, abs=0.5)

    def test_symmetric(self):
        a = haversine_m(41.3265, 69.2347, 41.3111, 69.2797)
        b = haversine_m(41.3111, 69.2797, 41.3265, 69.2347)
        assert a == pytest.approx(b)

    def test_known_tashkent_distance(self):
        # Chorsu bazaar -> Amir Temur square is about 4 km.
        assert 3500 < haversine_m(41.3265, 69.2347, 41.3111, 69.2797) < 4500

    def test_antipodal_points_are_half_circumference(self):
        assert haversine_m(0, 0, 0, 180) == pytest.approx(math.pi * EARTH_RADIUS_M, rel=1e-9)

    def test_poles(self):
        assert haversine_m(90, 0, -90, 0) == pytest.approx(math.pi * EARTH_RADIUS_M, rel=1e-9)

    def test_date_line_wraps(self):
        assert haversine_m(0, 179.5, 0, -179.5) == pytest.approx(haversine_m(0, 0, 0, 1), rel=1e-9)

    def test_never_nan_for_near_antipodal_rounding(self):
        assert not math.isnan(haversine_m(0, 0, 0.0000001, 180))


class TestGeohash:
    def test_reference_vectors(self):
        # Vectors from the geohash reference implementation / Wikipedia.
        assert geohash_encode(57.64911, 10.40744, 11) == "u4pruydqqvj"
        assert geohash_encode(42.6, -5.6, 5) == "ezs42"

    def test_default_precision_is_six(self):
        assert geohash_encode(57.64911, 10.40744) == "u4pruy"

    def test_nearby_points_in_same_cell_share_hash(self):
        assert geohash_encode(41.3113, 69.2743) == geohash_encode(41.3114, 69.2744)

    def test_far_points_differ(self):
        assert geohash_encode(41.3111, 69.2797) != geohash_encode(41.4111, 69.2797)

    @pytest.mark.parametrize(("lat", "lng"), [(91, 0), (-91, 0), (0, 181), (0, -181)])
    def test_out_of_range_rejected(self, lat, lng):
        with pytest.raises(ValueError, match="range"):
            geohash_encode(lat, lng)

    @pytest.mark.parametrize("precision", [0, -1, 13])
    def test_bad_precision_rejected(self, precision):
        with pytest.raises(ValueError, match="precision"):
            geohash_encode(0, 0, precision)

    def test_extremes_encode(self):
        assert len(geohash_encode(90, 180)) == 6
        assert len(geohash_encode(-90, -180)) == 6

    def test_decode_centre_is_inside_the_encoded_cell(self):
        lat, lng = 41.3111, 69.2797
        cell = geohash_encode(lat, lng)
        c_lat, c_lng, lat_err, lng_err = geohash_decode(cell)
        assert abs(c_lat - lat) <= lat_err + 1e-12
        assert abs(c_lng - lng) <= lng_err + 1e-12
        assert geohash_encode(c_lat, c_lng) == cell

    def test_decode_rejects_invalid_characters(self):
        with pytest.raises(ValueError, match="geohash"):
            geohash_decode("u4pra!")  # '!' and 'a' are not in the alphabet
        with pytest.raises(ValueError, match="geohash"):
            geohash_decode("")

    def test_cell_radius_covers_every_corner(self):
        cell = geohash_encode(41.3111, 69.2797)
        c_lat, c_lng, lat_err, lng_err = geohash_decode(cell)
        radius = geohash_cell_radius_m(cell)
        for dlat in (-lat_err, lat_err):
            for dlng in (-lng_err, lng_err):
                assert haversine_m(c_lat, c_lng, c_lat + dlat, c_lng + dlng) <= radius + 1e-6
        assert 400 < radius < 800  # precision-6 cell at Tashkent latitude
