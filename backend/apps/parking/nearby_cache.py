"""Redis cache for nearby *candidates* (ARCHITECTURE 10.1e).

Key: ``nearby:<geohash6>:<slot_type|any>`` (user-independent), TTL 30 s. Radius, sort, only_open
and limit are NOT part of the key: they are applied in Python on the cached list, so one entry
per cell serves every query shape and radius expansion needs no extra database query.

Value: the static candidate list (no per-request values) for the nearest <= CAP lots around the
cell CENTRE, within MAX_RADIUS + the cell's covering radius (+ margin). Per-request values
(distance_m, duration_s, score, is_open) are recomputed for the caller's exact point.

Guarantee: the list is complete for every point of the cell and every radius up to MAX_RADIUS
ONLY when it is shorter than the cap. A full list (cap reached) is NOT cached by the service,
because then it is only guaranteed up to D_cap - cell_radius (D_cap = distance of its farthest
entry from the centre). Cached `free_slots` may be up to 30 s stale (bookings update the counter
immediately; WebSocket pushes keep the open map fresh).

A Redis outage, a misconfigured Redis or a corrupt entry only costs a cache miss.
"""

import json
import logging

from apps.core.redis_client import get_redis

from .ranking import NearbyLot

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 30


def cache_key(*, cell: str, slot_type: str | None) -> str:
    return f"nearby:{cell}:{slot_type or 'any'}"


def _redis():
    try:
        return get_redis()
    except Exception as exc:  # noqa: BLE001 - e.g. ImproperlyConfigured/ValueError: fail open
        logger.warning("nearby cache: redis unavailable: %s", type(exc).__name__)
        return None


def _reject_constant(name: str):
    raise ValueError(f"non-finite JSON constant {name}")


def load(key: str) -> list[NearbyLot] | None:
    """Cached candidates, or None on a miss / outage / unreadable entry."""
    client = _redis()
    if client is None:
        return None
    try:
        raw = client.get(key)
    except Exception as exc:  # noqa: BLE001 - RedisError and friends
        logger.warning("nearby cache read failed: %s", type(exc).__name__)
        return None
    if raw is None:
        return None
    try:
        items = json.loads(raw, parse_constant=_reject_constant)  # NaN/Infinity -> ValueError
        return [NearbyLot.from_json(item) for item in items]
    except (ValueError, KeyError, TypeError, ArithmeticError):
        logger.warning("nearby cache entry unreadable, ignoring")
        return None


def store(key: str, lots: list[NearbyLot]) -> None:
    client = _redis()
    if client is None:
        return
    try:
        payload = json.dumps([lot.to_json() for lot in lots], allow_nan=False)
        client.set(key, payload, ex=CACHE_TTL_SECONDS)
    except (TypeError, ValueError) as exc:
        logger.warning("nearby cache entry not serialisable: %s", type(exc).__name__)
    except Exception as exc:  # noqa: BLE001 - RedisError and friends
        logger.warning("nearby cache write failed: %s", type(exc).__name__)
