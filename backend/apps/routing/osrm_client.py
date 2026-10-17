"""OSRM HTTP client (httpx): Table API (nearby) and Route API (GET /routes).

Design rules:
* every failure becomes ``OsrmError`` (callers fail soft); messages never contain the URL, since
  OSRM_URL may carry credentials;
* the request path is built only from validated floats formatted by us, never from raw input;
* the response is size-capped while streaming and validated structurally before it is trusted;
* one overall time budget (3 s) covers connect + headers + body;
* circuit breaker: after a transport failure/timeout/5xx a short-lived Redis flag makes the
  next calls skip OSRM entirely (callers then fail soft at once instead of waiting 3 s each);
* the breaker opens only after BREAKER_FAILURE_THRESHOLD server failures inside
  BREAKER_WINDOW_SECONDS (Redis counter), so one slow request cannot take routing and nearby down;
* "no route between these points" (``NoRoute``/``NoSegment``) is an answer, not an outage:
  OSRM sends it with HTTP 200 or HTTP 400 and the parser handles both. It raises
  ``RouteNotFound`` and never touches the breaker.
"""

import json
import logging
import math
import threading
import time
from collections.abc import Callable, Sequence

import httpx
from django.conf import settings

from apps.core.redis_client import get_redis

logger = logging.getLogger(__name__)

OSRM_TIMEOUT_SECONDS = 3.0  # total budget per request
OSRM_CONNECT_TIMEOUT_SECONDS = 1.0
MAX_DESTINATIONS = 150  # M = 3K with K <= 50
MAX_BODY_BYTES = 1_000_000
DEFAULT_OSRM_URL = "http://localhost:5000"
BREAKER_KEY = "osrm:down"
BREAKER_TTL_SECONDS = 30
FAILURE_KEY = "osrm:failures"
BREAKER_FAILURE_THRESHOLD = 3  # timeouts/transport errors/5xx ...
BREAKER_WINDOW_SECONDS = 5  # ... inside this window open the breaker
SNAP_RADIUS_M = 500  # a point farther than this from a road is NoSegment (sea, other country)
OVERVIEWS = frozenset({"full", "simplified"})
MAX_ROUNDABOUT_EXIT = 50
MAX_ROUTE_COORDINATES = 20_000  # geometry points accepted from OSRM (more = bad payload)
MAX_RAW_STEPS = 5_000  # steps accepted from OSRM before simplification
MAX_LEGS = 10
NO_ROUTE_CODES = frozenset({"NoRoute", "NoSegment"})
HTTP_BAD_REQUEST = 400

LatLng = tuple[float, float]


class OsrmError(Exception):
    """OSRM unavailable, slow or returned something unusable.

    ``reason`` is a short, safe code that may be logged; the message may be anything.
    """

    def __init__(self, message: str = "OSRM error", *, reason: str = "unknown"):
        super().__init__(message)
        self.reason = reason


class RouteNotFound(Exception):  # noqa: N818 - domain name used across the routing API
    """OSRM answered, but there is no drivable route between the points (not an outage)."""


def get_base_url() -> str:
    return (getattr(settings, "OSRM_URL", "") or DEFAULT_OSRM_URL).rstrip("/")


def _coordinate(point: LatLng) -> str:
    lat, lng = point
    if not (math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError("invalid coordinate")
    return f"{lng:.6f},{lat:.6f}"  # OSRM wants lng,lat


def build_table_path(origin: LatLng, destinations: Sequence[LatLng]) -> str:
    """Path+query of a 1 x N Table request: source 0 = origin, destinations 1..N."""
    if not 1 <= len(destinations) <= MAX_DESTINATIONS:
        raise ValueError(f"need 1..{MAX_DESTINATIONS} destinations")
    coords = ";".join(_coordinate(p) for p in (origin, *destinations))
    indexes = ";".join(str(i) for i in range(1, len(destinations) + 1))
    return f"/table/v1/driving/{coords}?sources=0&destinations={indexes}&annotations=duration"


def build_route_path(src: LatLng, dst: LatLng, overview: str = "full") -> str:
    """Path+query of a Route request (driving, GeoJSON geometry, steps, bounded snap radius)."""
    if overview not in OVERVIEWS:
        raise ValueError("overview must be 'full' or 'simplified'")
    coords = f"{_coordinate(src)};{_coordinate(dst)}"
    return (
        f"/route/v1/driving/{coords}?overview={overview}&geometries=geojson&steps=true"
        f"&radiuses={SNAP_RADIUS_M};{SNAP_RADIUS_M}"
    )


def _is_number(value) -> bool:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an int too large for a float
        return False


def _is_duration(value) -> bool:
    return _is_number(value) and value >= 0


def parse_table_response(data, expected: int) -> list[float | None]:
    """Validate an OSRM Table JSON body; return `expected` seconds (None = unreachable)."""
    if not isinstance(data, dict) or data.get("code") != "Ok":
        raise OsrmError("OSRM returned an error code", reason="bad_code")
    durations = data.get("durations")
    if not isinstance(durations, list) or len(durations) != 1:
        raise OsrmError("unexpected durations matrix", reason="bad_payload")
    row = durations[0]
    if not isinstance(row, list) or len(row) != expected:
        raise OsrmError("unexpected durations row", reason="bad_payload")
    if any(value is not None and not _is_duration(value) for value in row):
        raise OsrmError("invalid duration value", reason="bad_payload")
    return [None if value is None else float(value) for value in row]


def _lng_lat(value) -> tuple[float, float]:
    if not isinstance(value, list | tuple) or len(value) < 2:
        raise OsrmError("invalid coordinate in route", reason="bad_payload")
    lng, lat = value[0], value[1]
    if not (_is_number(lng) and _is_number(lat) and -180 <= lng <= 180 and -90 <= lat <= 90):
        raise OsrmError("invalid coordinate in route", reason="bad_payload")
    return float(lng), float(lat)


def _parse_geometry(geometry) -> dict:
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
        raise OsrmError("route geometry is not a LineString", reason="bad_payload")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or not 2 <= len(coordinates) <= MAX_ROUTE_COORDINATES:
        raise OsrmError("route geometry size out of bounds", reason="bad_payload")
    return {
        "type": "LineString",
        "coordinates": [list(_lng_lat(point)) for point in coordinates],
    }


def _parse_step(step) -> dict:
    if not isinstance(step, dict):
        raise OsrmError("invalid step", reason="bad_payload")
    maneuver = step.get("maneuver")
    name = step.get("name", "")
    if not isinstance(maneuver, dict) or not isinstance(name, str):
        raise OsrmError("invalid step", reason="bad_payload")
    kind, modifier = maneuver.get("type"), maneuver.get("modifier")
    if not isinstance(kind, str) or not (modifier is None or isinstance(modifier, str)):
        raise OsrmError("invalid maneuver", reason="bad_payload")
    if not (_is_duration(step.get("distance")) and _is_duration(step.get("duration"))):
        raise OsrmError("invalid step totals", reason="bad_payload")
    lng, lat = _lng_lat(maneuver.get("location"))
    exit_number = maneuver.get("exit")
    if not (
        isinstance(exit_number, int)
        and not isinstance(exit_number, bool)
        and 1 <= exit_number <= MAX_ROUNDABOUT_EXIT
    ):
        exit_number = None  # absent or implausible: the instruction is still usable without it
    return {
        "name": name,
        "distance": float(step["distance"]),
        "duration": float(step["duration"]),
        "location": {"lat": lat, "lng": lng},
        "maneuver": {"type": kind, "modifier": modifier, "exit": exit_number},
    }


def _parse_steps(legs) -> list[dict]:
    if not isinstance(legs, list) or not 1 <= len(legs) <= MAX_LEGS:
        raise OsrmError("unexpected legs", reason="bad_payload")
    steps: list[dict] = []
    for leg in legs:
        raw_steps = leg.get("steps") if isinstance(leg, dict) else None
        if not isinstance(raw_steps, list):
            raise OsrmError("unexpected steps", reason="bad_payload")
        if len(steps) + len(raw_steps) > MAX_RAW_STEPS:
            raise OsrmError("too many steps", reason="bad_payload")
        steps.extend(_parse_step(step) for step in raw_steps)
    return steps


def parse_route_response(data, http_status: int = 200) -> dict:
    """Validate an OSRM Route JSON body.

    Returns ``{distance_m, duration_s, geometry, steps}`` (steps still raw: see
    ``apps.routing.steps.simplify_steps``). Raises RouteNotFound for NoRoute/NoSegment and
    OsrmError for anything else that is not a well-formed, plausible route.
    """
    if not isinstance(data, dict):
        raise OsrmError("OSRM returned an unexpected body", reason="bad_payload")
    code = data.get("code")
    if code in NO_ROUTE_CODES:
        raise RouteNotFound
    if code != "Ok" or http_status != httpx.codes.OK:
        raise OsrmError("OSRM returned an error code", reason="bad_code")
    routes = data.get("routes")
    if not isinstance(routes, list) or not routes or not isinstance(routes[0], dict):
        raise OsrmError("OSRM returned no routes", reason="bad_payload")
    best = routes[0]
    if not (_is_duration(best.get("distance")) and _is_duration(best.get("duration"))):
        raise OsrmError("invalid route totals", reason="bad_payload")
    return {
        "distance_m": round(best["distance"]),
        "duration_s": round(best["duration"]),
        "geometry": _parse_geometry(best.get("geometry")),
        "steps": _parse_steps(best.get("legs")),
    }


def _reject_constant(name: str):
    raise ValueError(f"non-finite JSON constant {name}")


def _redis():
    """The Redis client, or None when it cannot even be built (misconfiguration): fail open."""
    try:
        return get_redis()
    except Exception as exc:  # noqa: BLE001 - config errors must not turn into 500s
        logger.warning("osrm breaker: redis unavailable: %s", type(exc).__name__)
        return None


def _breaker_is_open() -> bool:
    client = _redis()
    if client is None:
        return False
    try:
        return client.get(BREAKER_KEY) is not None
    except Exception as exc:  # noqa: BLE001 - RedisError and friends: assume closed
        logger.warning("osrm breaker read failed: %s", type(exc).__name__)
        return False


def _record_failure() -> None:
    """Count a server failure; open the breaker at BREAKER_FAILURE_THRESHOLD inside the window."""
    client = _redis()
    if client is None:
        return
    try:
        count = client.incr(FAILURE_KEY)
        if count == 1 or client.ttl(FAILURE_KEY) < 0:  # never leave a counter without expiry
            client.expire(FAILURE_KEY, BREAKER_WINDOW_SECONDS)
        if count >= BREAKER_FAILURE_THRESHOLD:
            client.set(BREAKER_KEY, "1", ex=BREAKER_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001 - fail open
        logger.warning("osrm breaker write failed: %s", type(exc).__name__)


def _should_trip(reason: str) -> bool:
    return reason in {"timeout", "transport"} or reason.startswith("http_5")


class OsrmClient:
    """OSRM access over one shared ``httpx.Client`` (connection pooling, thread-safe)."""

    def __init__(
        self,
        http: httpx.Client | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        budget_seconds: float = OSRM_TIMEOUT_SECONDS,
    ):
        self._http = http
        self._clock = clock
        self._budget = budget_seconds
        self._lock = threading.Lock()

    @property
    def http(self) -> httpx.Client:
        if self._http is None:
            with self._lock:
                if self._http is None:
                    self._http = httpx.Client(
                        follow_redirects=False,
                        trust_env=False,  # ignore HTTP(S)_PROXY / netrc / SSL_CERT_* env vars
                        headers={"Accept-Encoding": "identity"},  # no compression-bomb surface
                        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                    )
        return self._http

    def close(self) -> None:
        """Close the pooled connections (if any were ever opened)."""
        with self._lock:
            http, self._http = self._http, None
        if http is not None:
            http.close()

    def table(self, origin: LatLng, destinations: Sequence[LatLng]) -> list[float | None]:
        """Road travel time in seconds from `origin` to each destination, in one request."""
        path = build_table_path(origin, destinations)
        body = self._guarded(path)[1]
        return parse_table_response(body, len(destinations))

    def route(self, src: LatLng, dst: LatLng, *, overview: str = "full") -> dict:
        """Driving route src -> dst as validated ``{distance_m, duration_s, geometry, steps}``.

        `overview` is "full" (exact geometry, needed for off-route detection) or "simplified"
        (far fewer points; used for long routes).

        Raises RouteNotFound (no drivable route; the breaker is untouched), OsrmError
        (unavailable/garbage) or ValueError (invalid coordinates/overview: a caller bug).
        """
        path = build_route_path(src, dst, overview)
        status, body = self._guarded(path, accept_400=True)
        return parse_route_response(body, status)

    def _guarded(self, path: str, *, accept_400: bool = False):
        """Breaker check + request; transport/timeout/5xx trip the breaker."""
        if _breaker_is_open():
            raise OsrmError("OSRM circuit open", reason="circuit_open")
        try:
            return self._request_json(get_base_url() + path, accept_400=accept_400)
        except OsrmError as exc:
            if _should_trip(exc.reason):
                _record_failure()
            raise

    def _request_json(self, url: str, *, accept_400: bool = False):
        """``(status, parsed JSON)``. OSRM answers NoRoute with HTTP 400 and a JSON body."""
        deadline = self._clock() + self._budget
        # Every phase is capped by the one budget; the chunk loop below enforces the total (a
        # slow-dripping body can overshoot by at most one read timeout, i.e. one budget).
        connect = min(OSRM_CONNECT_TIMEOUT_SECONDS, self._budget)
        timeout = httpx.Timeout(self._budget, connect=connect, pool=connect)
        try:
            with self.http.stream("GET", url, timeout=timeout) as response:
                status = response.status_code
                if status != httpx.codes.OK and not (accept_400 and status == HTTP_BAD_REQUEST):
                    raise OsrmError("OSRM HTTP error", reason=f"http_{status}")
                declared = response.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
                    raise OsrmError("OSRM response too large", reason="too_large")
                body = bytearray()
                for chunk in response.iter_bytes():
                    if self._clock() > deadline:
                        raise OsrmError("OSRM too slow", reason="timeout")
                    body.extend(chunk)
                    if len(body) > MAX_BODY_BYTES:
                        raise OsrmError("OSRM response too large", reason="too_large")
        except httpx.InvalidURL:  # a malformed OSRM_URL; its text may hold secrets: not echoed
            raise OsrmError("OSRM URL is invalid", reason="bad_url") from None
        except httpx.TimeoutException:
            raise OsrmError("OSRM timed out", reason="timeout") from None
        except httpx.HTTPError:
            raise OsrmError("OSRM request failed", reason="transport") from None
        try:
            return status, json.loads(body, parse_constant=_reject_constant)
        except (ValueError, RecursionError):  # RecursionError: absurdly nested JSON
            raise OsrmError("OSRM returned invalid JSON", reason="bad_json") from None


_default_client: OsrmClient | None = None
_default_lock = threading.Lock()


def get_osrm_client() -> OsrmClient:
    """The process-wide client (one pooled httpx.Client); thread-safe lazy creation."""
    global _default_client  # noqa: PLW0603
    if _default_client is None:
        with _default_lock:
            if _default_client is None:
                _default_client = OsrmClient()
    return _default_client


def set_osrm_client(client: OsrmClient | None) -> None:
    """Install a client (tests); None resets to the lazy default."""
    global _default_client  # noqa: PLW0603
    with _default_lock:
        old, _default_client = _default_client, client
    if old is not None and old is not client:
        old.close()


def _pick(client: httpx.Client | None) -> OsrmClient:
    return OsrmClient(client) if client is not None else get_osrm_client()


def table(
    origin: LatLng, destinations: Sequence[LatLng], *, client: httpx.Client | None = None
) -> list[float | None]:
    """Module-level shortcut used by the services; `client` is for tests (custom transport)."""
    return _pick(client).table(origin, destinations)


def route(
    src: LatLng, dst: LatLng, *, overview: str = "full", client: httpx.Client | None = None
) -> dict:
    """Module-level shortcut for ``OsrmClient.route`` (used by routing.services)."""
    return _pick(client).route(src, dst, overview=overview)
