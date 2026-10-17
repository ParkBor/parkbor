"""GeoDjango compatibility layer.

Production/CI use real PostGIS fields (GDAL + GEOS installed). On machines without GDAL
(e.g. a plain Windows dev box) importing ``django.contrib.gis.db.models`` raises. Only when
``settings.GEO_STUB`` is True (dev/test settings, never base/prod) we expose lightweight
stand-ins that *deconstruct exactly like the real fields*, so migrations stay in sync and
non-spatial code (serializers, permissions, services) can still be imported and tested.
Spatial behaviour itself is only tested under ``@pytest.mark.postgis``.
"""

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import models

from . import gis_detect

HAS_GIS = gis_detect.detect_gis()

if not HAS_GIS and not getattr(settings, "GEO_STUB", False):
    # Fail closed: production must never silently run with text columns instead of geography.
    raise ImproperlyConfigured(
        "GDAL/GEOS are required. Install them, or (dev/test only) set GEO_STUB = True. "
        f"Cause: {gis_detect.last_failure() or 'unknown'}"
    )

if HAS_GIS:
    from django.contrib.gis.db.models import PointField, PolygonField
else:

    class _StubGeometryField(models.TextField):
        """Text-backed placeholder; deconstructs as the real GIS field."""

        real_path = ""

        def __init__(self, *args, geography=False, srid=4326, spatial_index=True, dim=2, **kw):
            self.geography = geography
            self.srid = srid
            self.spatial_index = spatial_index
            self.dim = dim
            super().__init__(*args, **kw)

        def deconstruct(self):
            name, _path, args, kwargs = super().deconstruct()
            if self.srid != 4326:
                kwargs["srid"] = self.srid
            if self.dim != 2:
                kwargs["dim"] = self.dim
            if not self.spatial_index:
                kwargs["spatial_index"] = False
            if self.geography:
                kwargs["geography"] = True
            return name, self.real_path, args, kwargs

    class PointField(_StubGeometryField):
        real_path = "django.contrib.gis.db.models.fields.PointField"

    class PolygonField(_StubGeometryField):
        real_path = "django.contrib.gis.db.models.fields.PolygonField"


def make_point(lng: float, lat: float):
    """Build a WGS84 Point (needs GEOS; only called on real PostGIS code paths)."""
    if not HAS_GIS:
        return f"POINT({lng} {lat})"
    from django.contrib.gis.geos import Point

    return Point(lng, lat, srid=4326)


def make_polygon(ring: list[tuple[float, float]]):
    """Build a WGS84 Polygon from a closed [(lng, lat), ...] ring."""
    if not HAS_GIS:
        return "POLYGON((" + ",".join(f"{x} {y}" for x, y in ring) + "))"
    from django.contrib.gis.geos import Polygon

    return Polygon(ring, srid=4326)


def point_to_lnglat(value) -> tuple[float, float] | None:
    """Return (lng, lat) from a Point, or from the stub's WKT text."""
    if value is None:
        return None
    if hasattr(value, "x"):
        return float(value.x), float(value.y)
    inner = str(value).removeprefix("POINT(").removesuffix(")")
    lng, lat = inner.split()
    return float(lng), float(lat)


def polygon_to_ring(value) -> list[tuple[float, float]] | None:
    """Return the exterior ring as [(lng, lat), ...], or None."""
    if value is None:
        return None
    if hasattr(value, "exterior_ring"):
        return [(float(x), float(y)) for x, y in value.exterior_ring.coords]
    inner = str(value).removeprefix("POLYGON((").removesuffix("))")
    return [(float(p.split()[0]), float(p.split()[1])) for p in inner.split(",")]
