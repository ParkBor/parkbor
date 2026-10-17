"""Broadcasts to the channel layer (ARCHITECTURE 12). Listeners of ``apps.core.events``.

All of them run AFTER the originating transaction committed (the bookings hooks call them from
``transaction.on_commit``), so they never re-wrap in ``on_commit``. They are FAIL-OPEN: a dead
Redis / channel layer is logged and swallowed, never raised into the booking flow.

Messages carry ids, counters and statuses only: never a plate, phone or name.
"""

import asyncio
import logging

import redis
from asgiref.sync import async_to_sync
from celery import shared_task
from channels.layers import get_channel_layer
from django.conf import settings

from apps.core.redis_client import get_redis

from . import groups, queries

logger = logging.getLogger(__name__)

EVENT_TYPE = "realtime.event"  # consumer handler: AvailabilityConsumer.realtime_event
_LAST_KEY = "rt:avail:last:"  # leading-edge window of one lot
_TRAIL_KEY = "rt:avail:trail:"  # a trailing flush is already scheduled for this lot
_TRAIL_TTL_FACTOR = 5
_FLUSH_MARGIN_SECONDS = 0.05
SEND_TIMEOUT_SECONDS = 2
FLUSH_EXPIRES_SECONDS = 30  # a flush older than this is pointless: a newer state went out


# --- low level --------------------------------------------------------------------------------


async def _group_send_many(layer, items: list[tuple[str, dict]]) -> None:
    # A Redis that accepts the connection but answers slowly must not hold a request, a sweep or
    # a Celery worker: the whole send is bounded (the layer's own timeouts are longer, because
    # its receive side blocks on purpose).
    async with asyncio.timeout(SEND_TIMEOUT_SECONDS):
        for group, payload in items:
            await layer.group_send(group, {"type": EVENT_TYPE, "payload": payload})


def _send(items: list[tuple[str, dict]]) -> bool:
    """Deliver ``(group, payload)`` pairs. True when handed to the layer; False (and logged) on
    any failure: the caller's transaction is long committed, there is nothing to undo."""
    try:
        layer = get_channel_layer()
        if layer is None:
            return False
        async_to_sync(_group_send_many)(layer, items)
    except Exception:  # noqa: BLE001 - fail open: Redis down must not break bookings
        logger.exception("channel layer unavailable: %d realtime message(s) dropped", len(items))
        return False
    return True


# --- availability (lot_<id> + geo_<geohash5>) --------------------------------------------------


def broadcast_availability(lot_id) -> bool:
    """Read the lot's counters from the database NOW and send them to the lot and area groups."""
    snapshot = queries.availability_snapshot(lot_id)
    if snapshot is None:
        return False
    payload = queries.availability_payload(snapshot)
    items = [(groups.lot_group(snapshot["lot_id"]), payload)]
    if snapshot["lng_lat"] is not None:
        lng, lat = snapshot["lng_lat"]
        try:
            items.append((groups.geo_group(groups.geohash5_of(lat, lng)), payload))
        except (ValueError, groups.InvalidGroup):
            logger.warning("lot %s has no usable location for the area group", lot_id)
    return _send(items)


def _debounce_ms() -> int:
    return settings.WS_DEBOUNCE_MILLISECONDS


def _claim_send_window(lot_id) -> bool:
    """True when this call may send now (it opened a new window); Redis down -> True (fail-open)."""
    try:
        return bool(get_redis().set(f"{_LAST_KEY}{lot_id}", "1", nx=True, px=_debounce_ms()))
    except redis.RedisError:
        return True


def _claim_trailing_flush(lot_id) -> bool:
    try:
        ttl = _debounce_ms() * _TRAIL_TTL_FACTOR
        return bool(get_redis().set(f"{_TRAIL_KEY}{lot_id}", "1", nx=True, px=ttl))
    except redis.RedisError:
        return False  # cannot track it: the immediate fallback in the caller sends instead


def _release_trailing_flush(lot_id) -> None:
    try:
        get_redis().delete(f"{_TRAIL_KEY}{lot_id}")
    except redis.RedisError:
        pass  # the flag has a TTL


def on_availability_changed(*, lot_id) -> None:
    """Leading + trailing debounce: the first change of a burst goes out at once, the rest of the
    window is covered by ONE delayed flush that reads the final state."""
    if _claim_send_window(lot_id):
        broadcast_availability(lot_id)
        return
    if not _claim_trailing_flush(lot_id):
        # Either a flush is already scheduled (nothing to do) or Redis is down; when we cannot
        # tell which, sending now is the safe answer and costs at most one extra message.
        if not _flush_is_scheduled(lot_id):
            broadcast_availability(lot_id)
        return
    try:
        flush_availability.apply_async(
            args=[str(lot_id)],
            countdown=_debounce_ms() / 1000 + _FLUSH_MARGIN_SECONDS,
            expires=FLUSH_EXPIRES_SECONDS,
        )
    except Exception:  # noqa: BLE001 - broker down: send now instead of losing the update
        logger.exception("could not schedule the availability flush for lot %s", lot_id)
        _release_trailing_flush(lot_id)
        broadcast_availability(lot_id)


def _flush_is_scheduled(lot_id) -> bool:
    try:
        return bool(get_redis().exists(f"{_TRAIL_KEY}{lot_id}"))
    except redis.RedisError:
        return False


@shared_task(
    name="realtime.flush_availability", ignore_result=True, soft_time_limit=20, time_limit=30
)
def flush_availability(lot_id: str) -> bool:
    """The trailing edge of a debounced burst: send the latest state, reopen the window."""
    _release_trailing_flush(lot_id)
    _claim_send_window(lot_id)  # changes right after this flush are coalesced again
    return broadcast_availability(lot_id)


# --- booking_status (user_<id>) ----------------------------------------------------------------


def on_booking_status(*, booking_id, user_id, lot_id, status, previous) -> None:
    if user_id is None:  # a walk-in has no account: nobody to tell
        return
    payload = {"type": "booking_status", "booking_id": str(booking_id), "status": str(status)}
    _send([(groups.user_group(user_id), payload)])


# --- slot_status (operator_lot_<id>) -----------------------------------------------------------


def _slot_payload(lot_id, slot_id, status) -> dict:
    return {
        "type": "slot_status",
        "lot_id": str(lot_id),
        "slot_id": str(slot_id),
        "status": str(status),
    }


def on_slot_status(*, lot_id, slot_id, status) -> None:
    _send([(groups.operator_group(lot_id), _slot_payload(lot_id, slot_id, status))])


def on_slot_reassigned(*, booking_id, old_slot_id, new_slot_id, lot_id, **_ignored) -> None:
    """A booking moved between slots: the operator map shows both slots' CURRENT status again."""
    current = queries.slot_statuses([old_slot_id, new_slot_id])
    group = groups.operator_group(lot_id)
    _send([(group, _slot_payload(lot_id, slot_id, status)) for slot_id, status in current.items()])
