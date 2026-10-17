"""Pure geo maths (no GDAL, no Django): Haversine distance and geohash.

ARCHITECTURE 10.1a (Haversine) and 10.1e (geohash cache key).
"""

import math

EARTH_RADIUS_M = 6_371_000.0

_GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz"
_GEOHASH_INDEX = {char: index for index, char in enumerate(_GEOHASH_ALPHABET)}
MAX_GEOHASH_PRECISION = 12
DEFAULT_GEOHASH_PRECISION = 6  # ~1.2 km x 0.6 km cell


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres between two WGS84 points (degrees)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    a = min(1.0, max(0.0, a))  # rounding can push it a hair outside [0, 1] near antipodes
    return 2 * EARTH_RADIUS_M * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def geohash_encode(lat: float, lng: float, precision: int = DEFAULT_GEOHASH_PRECISION) -> str:
    """Standard geohash of a point."""
    if not 1 <= precision <= MAX_GEOHASH_PRECISION:
        raise ValueError(f"precision must be in 1..{MAX_GEOHASH_PRECISION}")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError("lat/lng out of range")
    lat_range, lng_range = [-90.0, 90.0], [-180.0, 180.0]
    chars: list[str] = []
    bits = bit_count = 0
    use_lng = True  # bits alternate, starting with longitude
    while len(chars) < precision:
        interval = lng_range if use_lng else lat_range
        value = lng if use_lng else lat
        mid = (interval[0] + interval[1]) / 2
        bits <<= 1
        if value >= mid:
            bits |= 1
            interval[0] = mid
        else:
            interval[1] = mid
        use_lng = not use_lng
        bit_count += 1
        if bit_count == 5:
            chars.append(_GEOHASH_ALPHABET[bits])
            bits = bit_count = 0
    return "".join(chars)


def geohash_decode(geohash: str) -> tuple[float, float, float, float]:
    """Return (lat, lng, lat_error, lng_error): the cell centre and its half-extent in degrees."""
    if not geohash or any(char not in _GEOHASH_INDEX for char in geohash):
        raise ValueError("invalid geohash")
    lat_range, lng_range = [-90.0, 90.0], [-180.0, 180.0]
    use_lng = True
    for char in geohash:
        value = _GEOHASH_INDEX[char]
        for shift in range(4, -1, -1):
            interval = lng_range if use_lng else lat_range
            mid = (interval[0] + interval[1]) / 2
            interval[0 if (value >> shift) & 1 else 1] = mid
            use_lng = not use_lng
    return (
        (lat_range[0] + lat_range[1]) / 2,
        (lng_range[0] + lng_range[1]) / 2,
        (lat_range[1] - lat_range[0]) / 2,
        (lng_range[1] - lng_range[0]) / 2,
    )


def geohash_cell_radius_m(geohash: str) -> float:
    """Distance from the cell centre to its farthest corner (a safe covering radius)."""
    lat, lng, lat_err, lng_err = geohash_decode(geohash)
    return max(
        haversine_m(lat, lng, lat + dlat, lng + dlng)
        for dlat in (-lat_err, lat_err)
        for dlng in (-lng_err, lng_err)
    )


def _checked_lng_lat(point) -> tuple[float, float]:
    try:
        lng, lat = point[0], point[1]
    except (TypeError, IndexError, KeyError):
        raise ValueError("polyline point must be [lng, lat]") from None
    for value in (lng, lat):
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ValueError("polyline coordinates must be numbers")
    try:
        in_range = (
            math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180
        )
    except OverflowError:  # an int too large for a float
        in_range = False
    if not in_range:
        raise ValueError("polyline coordinate out of range")
    return float(lng), float(lat)


def _segment_distance(ax: float, ay: float, bx: float, by: float) -> float:
    """Distance from the origin to segment AB (planar, metres)."""
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length_sq))
    return math.hypot(ax + t * dx, ay + t * dy)


def distance_to_polyline_m(lat: float, lng: float, line) -> float:
    """Shortest distance in metres from a point to a polyline (rerouting check, ARCH 10.2).

    `line` is GeoJSON order: a sequence of [lng, lat] (extra components such as altitude are
    ignored), i.e. the `geometry.coordinates` of GET /routes can be passed as is. The mobile app
    re-requests a route when this exceeds 50 m.

    Each segment is projected onto a local plane centred on the query point (equirectangular), so
    the error is far below GPS noise for segments up to a few km (< 0.1 % at <= 5 km). Very long
    straight segments (the 2-point `fallback` route) are only approximate. Longitude differences
    are wrapped, so antimeridian-crossing segments work. Raises ValueError on invalid input.
    """
    if isinstance(lat, bool) or isinstance(lng, bool):
        raise ValueError("invalid query point")
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError, OverflowError):
        raise ValueError("invalid query point") from None
    if not (math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError("invalid query point")
    if isinstance(line, str | bytes) or not hasattr(line, "__iter__"):
        raise ValueError("polyline must be a sequence of points")
    points = [_checked_lng_lat(point) for point in line]
    if not points:
        raise ValueError("polyline is empty")

    cos_lat = math.cos(math.radians(lat))
    metres_per_degree = EARTH_RADIUS_M * math.pi / 180

    # Unwrap longitudes along the line: the first point relative to the query point, every next
    # one relative to its predecessor, so a segment 179 -> -179 stays 2 degrees long wherever the
    # query point is (wrapping each point on its own would turn it into a 358 degree segment).
    flat: list[tuple[float, float]] = []
    x_deg = 0.0
    previous_lng = lng
    for point_lng, point_lat in points:
        x_deg += (point_lng - previous_lng + 180.0) % 360.0 - 180.0
        previous_lng = point_lng
        flat.append((x_deg * cos_lat * metres_per_degree, (point_lat - lat) * metres_per_degree))
    if len(flat) == 1:
        return math.hypot(*flat[0])
    return min(
        _segment_distance(ax, ay, bx, by)
        for (ax, ay), (bx, by) in zip(flat, flat[1:], strict=False)
    )
