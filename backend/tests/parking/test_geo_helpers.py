import pytest

from apps.core import geo


def test_stub_point_roundtrip_without_gdal():
    if geo.HAS_GIS:
        pytest.skip("real GEOS available; covered by postgis tests")
    point = geo.make_point(69.24, 41.31)
    assert geo.point_to_lnglat(point) == (69.24, 41.31)


def test_none_passes_through():
    assert geo.point_to_lnglat(None) is None
    assert geo.polygon_to_ring(None) is None


def test_stub_polygon_roundtrip_without_gdal():
    if geo.HAS_GIS:
        pytest.skip("real GEOS available")
    ring = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0)]
    assert geo.polygon_to_ring(geo.make_polygon(ring)) == ring


def test_stub_field_deconstructs_like_real_gis_field():
    if geo.HAS_GIS:
        pytest.skip("real GIS field in use")
    field = geo.PointField(geography=True, spatial_index=False)
    _, path, _, kwargs = field.deconstruct()
    assert path == "django.contrib.gis.db.models.fields.PointField"
    assert kwargs == {"geography": True, "spatial_index": False}
