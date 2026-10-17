"""Service-area and distance limits for routing (imported by settings: keep imports light).

* ``ROUTING_BBOX`` = (lat_min, lat_max, lng_min, lng_max): both points must lie inside.
  Default is Uzbekistan plus a margin for the border regions.
* ``ROUTING_MAX_STRAIGHT_KM``: maximum straight-line distance between the points. It bounds the
  work OSRM does for one request and keeps the straight-line fallback from ever producing an
  absurd "route" (e.g. intercontinental).
"""

import math

from django.core.exceptions import ImproperlyConfigured

from apps.core.geomath import haversine_m

DEFAULT_BBOX = "36.5,46.0,55.5,74.5"
DEFAULT_MAX_STRAIGHT_KM = 2000.0
DEFAULT_FULL_OVERVIEW_MAX_KM = 100.0  # beyond this straight distance OSRM gets overview=simplified

Bbox = tuple[float, float, float, float]


def parse_bbox(raw: str) -> Bbox:
    """``"lat_min,lat_max,lng_min,lng_max"`` -> validated tuple. The message never echoes `raw`."""
    try:
        lat_min, lat_max, lng_min, lng_max = (float(part) for part in raw.split(","))
    except ValueError:
        raise ImproperlyConfigured(
            "ROUTING_BBOX must be 'lat_min,lat_max,lng_min,lng_max' (four numbers)."
        ) from None
    values = (lat_min, lat_max, lng_min, lng_max)
    valid = (
        all(math.isfinite(v) for v in values)
        and -90 <= lat_min < lat_max <= 90
        and -180 <= lng_min < lng_max <= 180
    )
    if not valid:
        raise ImproperlyConfigured("ROUTING_BBOX is out of range or its min/max are swapped.")
    return values


def _settings():
    from django.conf import settings

    bbox = getattr(settings, "ROUTING_BBOX", None) or parse_bbox(DEFAULT_BBOX)
    max_km = getattr(settings, "ROUTING_MAX_STRAIGHT_KM", DEFAULT_MAX_STRAIGHT_KM)
    return bbox, max_km


def route_allowed(src: tuple[float, float], dst: tuple[float, float]) -> bool:
    """True when both ``(lat, lng)`` points are inside the service area and close enough."""
    (lat_min, lat_max, lng_min, lng_max), max_km = _settings()
    for lat, lng in (src, dst):
        if not (lat_min <= lat <= lat_max and lng_min <= lng <= lng_max):
            return False
    return haversine_m(src[0], src[1], dst[0], dst[1]) <= max_km * 1000


def full_overview_max_km() -> float:
    from django.conf import settings

    return getattr(settings, "ROUTING_FULL_OVERVIEW_MAX_KM", DEFAULT_FULL_OVERVIEW_MAX_KM)
