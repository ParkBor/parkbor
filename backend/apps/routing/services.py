"""Route service (ARCHITECTURE 10.2): limits -> Redis cache -> OSRM -> straight-line fallback.

Flow of ``get_route(src, dst)``:
0. Both points must be inside ``ROUTING_BBOX`` and at most ``ROUTING_MAX_STRAIGHT_KM`` apart,
   else ``RouteTooFarError`` (HTTP 400 ``route_too_far``).
1. Redis ``route:<src lat 4dp>:<src lng 4dp>:<dst lat 6dp>:<dst lng 6dp>`` (TTL 300 s, user
   independent). Entries are HMAC-signed with SECRET_KEY, so reading one needs only cheap
   structural checks. A Redis outage or an unreadable/unsigned entry only costs a miss.
2. Miss -> ``osrm_client.route``. The SOURCE is rounded to 4 decimals (~11 m) both in the key
   and in the request, so one key always means one answer; the first geometry point can differ
   from the requested start by up to ~8 m (OSRM snaps to the road anyway; GPS noise is larger).
   The DESTINATION is exact (6 decimals): destinations are parking lots and two lots a few
   metres apart must never share a cached route.
3. OSRM down/slow/garbage (``OsrmError``, incl. the open circuit breaker) -> straight-line
   fallback, ``source == "fallback"`` and ``approximate == True``. Fallbacks are never cached
   (recovery is immediate), except that answers OSRM could not deliver sensibly
   (too_large/bad_payload/bad_json) leave a 45 s negative marker so a hot pair does not hammer
   OSRM. NoRoute (``RouteNotFound``) is an answer, not an outage: it propagates (HTTP 404).
4. Entries over 256 KB are not cached; over 100 KB they live 60 s only. Long routes ask OSRM for
   ``overview=simplified``.

Not done: single-flight (concurrent misses for one key each call OSRM); the 3 s budget and the
breaker bound the damage. The A* library (``astar.py``) is not used here yet (no graph source).
"""

import hashlib
import hmac
import json
import logging
import math

from django.conf import settings

from apps.core.geomath import haversine_m
from apps.core.redis_client import get_redis
from apps.routing import limits, osrm_client
from apps.routing.errors import RouteTooFarError, RoutingUnavailable
from apps.routing.osrm_client import MAX_ROUTE_COORDINATES, LatLng, OsrmError, RouteNotFound
from apps.routing.steps import INSTRUCTION_KEYS, MAX_STEPS, simplify_steps

logger = logging.getLogger(__name__)

__all__ = ["RouteNotFound", "RoutingUnavailable", "get_route", "straight_line_route"]

CACHE_TTL_SECONDS = 300
LARGE_ENTRY_TTL_SECONDS = 60
NEGATIVE_TTL_SECONDS = 45
LARGE_ENTRY_BYTES = 100_000
MAX_CACHE_BYTES = 256 * 1024
FALLBACK_SPEED_KMH = 30  # assumed average urban speed for the straight-line estimate
SOURCE_OSRM = "osrm"
SOURCE_FALLBACK = "fallback"
NEGATIVE_MARKER = "!"
NEGATIVE_REASONS = frozenset({"too_large", "bad_payload", "bad_json"})
_RESULT_KEYS = {"distance_m", "duration_s", "geometry", "steps", "source", "approximate"}


def _normalised(value: float, decimals: int) -> float:
    return round(value, decimals) + 0.0  # + 0.0 turns -0.0 into 0.0


def cache_key(src: LatLng, dst: LatLng) -> str:
    return (
        f"route:{_normalised(src[0], 4):.4f}:{_normalised(src[1], 4):.4f}"
        f":{_normalised(dst[0], 6):.6f}:{_normalised(dst[1], 6):.6f}"
    )


# --- signed cache entries ------------------------------------------------------------------------


def sign(body: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode(), body.encode(), hashlib.sha256).hexdigest()


def pack(result) -> str:
    body = json.dumps(result, allow_nan=False)
    return f"{sign(body)}:{body}"


def _reject_constant(name: str):
    raise ValueError(f"non-finite JSON constant {name}")


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_coord(value, low: float, high: float) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and low <= value <= high
    )


def _is_point(point) -> bool:
    return (
        isinstance(point, list)
        and len(point) == 2  # noqa: PLR2004
        and _is_coord(point[0], -180, 180)
        and _is_coord(point[1], -90, 90)
    )


def _valid_result(data) -> bool:
    """Cheap sanity check; integrity itself is guaranteed by the signature."""
    if not isinstance(data, dict) or set(data) != _RESULT_KEYS:
        return False
    if data["source"] != SOURCE_OSRM or data["approximate"] is not False:
        return False
    geometry, steps = data["geometry"], data["steps"]
    if not (isinstance(geometry, dict) and geometry.get("type") == "LineString"):
        return False
    points = geometry.get("coordinates")
    return (
        _is_int(data["distance_m"])
        and _is_int(data["duration_s"])
        and isinstance(points, list)
        and 2 <= len(points) <= MAX_ROUTE_COORDINATES  # noqa: PLR2004
        and _is_point(points[0])
        and _is_point(points[-1])
        and isinstance(steps, list)
        and len(steps) <= MAX_STEPS
        and all(
            isinstance(step, dict) and step.get("instruction_key") in INSTRUCTION_KEYS
            for step in steps
        )
    )


def unpack(raw: str) -> dict | None:
    """The cached result, or None for anything unsigned, tampered, unparsable or implausible."""
    mac, separator, body = raw.partition(":")
    if not separator or not hmac.compare_digest(mac, sign(body)):
        return None
    try:
        data = json.loads(body, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return None
    return data if _valid_result(data) else None


# --- cache access (fail-open) --------------------------------------------------------------------


def _redis():
    try:
        return get_redis()
    except Exception as exc:  # noqa: BLE001 - e.g. ImproperlyConfigured/ValueError: fail open
        logger.warning("route cache: redis unavailable: %s", type(exc).__name__)
        return None


def _load(key: str):
    """A cached result dict, ``NEGATIVE_MARKER``, or None (miss/outage/unusable entry)."""
    client = _redis()
    if client is None:
        return None
    try:
        raw = client.get(key)
    except Exception as exc:  # noqa: BLE001 - RedisError and friends
        logger.warning("route cache read failed: %s", type(exc).__name__)
        return None
    if raw is None:
        return None
    if raw == NEGATIVE_MARKER:
        return NEGATIVE_MARKER
    data = unpack(raw)
    if data is None:
        logger.warning("route cache entry unusable, ignoring")
    return data


def _set(key: str, value: str, ttl: int) -> None:
    client = _redis()
    if client is None:
        return
    try:
        client.set(key, value, ex=ttl)
    except Exception as exc:  # noqa: BLE001 - RedisError and friends
        logger.warning("route cache write failed: %s", type(exc).__name__)


def _store(key: str, result: dict) -> None:
    try:
        packed = pack(result)
    except (TypeError, ValueError) as exc:
        logger.warning("route cache entry not serialisable: %s", type(exc).__name__)
        return
    if len(packed) > MAX_CACHE_BYTES:
        logger.info("route not cached: %d bytes", len(packed))
        return
    ttl = LARGE_ENTRY_TTL_SECONDS if len(packed) > LARGE_ENTRY_BYTES else CACHE_TTL_SECONDS
    _set(key, packed, ttl)


# --- fallback ------------------------------------------------------------------------------------


def straight_line_route(src: LatLng, dst: LatLng) -> dict:
    """Rough estimate when OSRM is unavailable: a 2-point line at an assumed 30 km/h.

    Obeys the same service-area/distance limits as real routes (ValueError otherwise).
    """
    if not limits.route_allowed(src, dst):
        raise ValueError("points outside the service area or too far apart")
    meters = haversine_m(src[0], src[1], dst[0], dst[1])
    if not math.isfinite(meters):
        raise ValueError("invalid points")
    seconds = meters / (FALLBACK_SPEED_KMH / 3.6)

    def raw_step(kind: str, point: LatLng, distance: float, duration: float) -> dict:
        return {
            "name": "",
            "distance": distance,
            "duration": duration,
            "location": {"lat": point[0], "lng": point[1]},
            "maneuver": {"type": kind, "modifier": None, "exit": None},
        }

    return {
        "distance_m": round(meters),
        "duration_s": round(seconds),
        "geometry": {"type": "LineString", "coordinates": [[src[1], src[0]], [dst[1], dst[0]]]},
        "steps": simplify_steps(
            [raw_step("depart", src, meters, seconds), raw_step("arrive", dst, 0.0, 0.0)]
        ),
        "source": SOURCE_FALLBACK,
        "approximate": True,
    }


def _fallback(src: LatLng, dst: LatLng) -> dict:
    try:
        return straight_line_route(src, dst)
    except (ValueError, ArithmeticError) as exc:
        logger.error("route fallback failed: %s", type(exc).__name__)
        raise RoutingUnavailable from None


# --- public --------------------------------------------------------------------------------------


def get_route(src: LatLng, dst: LatLng) -> dict:
    """Driving route src -> dst (``(lat, lng)`` tuples, already validated by the caller).

    Raises RouteTooFarError, RouteNotFound (no drivable route) or RoutingUnavailable.
    """
    if not limits.route_allowed(src, dst):
        raise RouteTooFarError
    key = cache_key(src, dst)
    cached = _load(key)
    if cached == NEGATIVE_MARKER:
        return _fallback(src, dst)
    if cached is not None:
        return cached
    query_src = (_normalised(src[0], 4), _normalised(src[1], 4))
    query_dst = (_normalised(dst[0], 6), _normalised(dst[1], 6))
    straight_m = haversine_m(src[0], src[1], dst[0], dst[1])
    overview = "full" if straight_m <= limits.full_overview_max_km() * 1000 else "simplified"
    try:
        raw = osrm_client.route(query_src, query_dst, overview=overview)
    except RouteNotFound:
        raise
    except OsrmError as exc:  # unavailable, slow, circuit open or garbage: degrade, don't fail
        logger.warning("osrm route failed: %s (%s)", type(exc).__name__, exc.reason)
        if exc.reason in NEGATIVE_REASONS:
            _set(key, NEGATIVE_MARKER, NEGATIVE_TTL_SECONDS)
        return _fallback(src, dst)
    result = {
        "distance_m": raw["distance_m"],
        "duration_s": raw["duration_s"],
        "geometry": raw["geometry"],
        "steps": simplify_steps(raw["steps"]),
        "source": SOURCE_OSRM,
        "approximate": False,
    }
    _store(key, result)
    return result
