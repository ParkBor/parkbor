"""Expo push receipts: the second half of a push. A ticket says "accepted"; the receipt, minutes
later, says "delivered" or "DeviceNotRegistered". Tickets are remembered in Redis, receipts are
read by ``notifications.check_push_receipts`` and dead devices are deleted.

FAIL-OPEN: Redis problems only mean a receipt is not checked (a dead token is also removed by age
and by the next send that gets DeviceNotRegistered directly).
"""

import logging
import time

import redis

from apps.accounts.models import Device
from apps.core.redis_client import get_redis

from .channels import expo_push
from .channels.expo_push import PushOutcome

logger = logging.getLogger(__name__)

KEY = "expo:tickets"
RECEIPT_DELAY_SECONDS = 900  # Expo recommends waiting about 15 minutes
RECEIPT_MAX_AGE_SECONDS = 24 * 3600  # Expo keeps receipts for 24 hours
BATCH = 1000
MAX_BATCHES = 10  # one run settles up to 10 000 tickets; the next run continues
KEY_TTL_SECONDS = RECEIPT_MAX_AGE_SECONDS + 3600


def remember(ticket_id: str, token: str, now: float | None = None) -> None:
    if not ticket_id:
        return
    try:
        pipe = get_redis().pipeline()
        pipe.zadd(KEY, {f"{ticket_id}|{token}": now if now is not None else time.time()})
        pipe.expire(KEY, KEY_TTL_SECONDS)  # the whole set vanishes if nothing refreshes it
        pipe.execute()
    except redis.RedisError:
        logger.warning("expo receipts: could not remember a ticket")


def _due_entries(client, now: float, start: int) -> dict[str, tuple[str, str]]:
    """ticket id -> (token, raw entry) for the tickets old enough to have a receipt, skipping the
    ``start`` oldest ones that are still waiting for theirs."""
    entries = client.zrangebyscore(KEY, 0, now - RECEIPT_DELAY_SECONDS, start=start, num=BATCH)
    due = {}
    for entry in entries:
        ticket, separator, token = entry.partition("|")
        if separator:
            due[ticket] = (token, entry)
        else:
            client.zrem(KEY, entry)  # malformed leftovers
    return due


def _fetch(ids: list[str]) -> dict:
    receipts = {}
    for start in range(0, len(ids), expo_push.MAX_RECEIPT_IDS):
        receipts.update(expo_push.get_receipts(ids[start : start + expo_push.MAX_RECEIPT_IDS]))
    return receipts


def _settle(client, due: dict, receipts: dict, now: float, counts: dict) -> int:
    """Handle one batch; returns how many entries stay (their receipt is not ready)."""
    waiting = 0
    for ticket, (token, entry) in due.items():
        receipt = receipts.get(ticket)
        if receipt is None:
            waiting += 1
            continue
        counts["checked"] += 1
        if receipt.outcome is PushOutcome.INVALID_TOKEN:
            counts["pruned"] += Device.objects.filter(expo_push_token=token).delete()[0]
        client.zrem(KEY, entry)
    return waiting


def check_receipts(now: float | None = None) -> dict[str, int]:
    """Read the receipts that are due, several batches per run; returns counts (checked / pruned
    / pending / expired). Entries Expo no longer keeps (older than 24 h) are trimmed every run."""
    now = now if now is not None else time.time()
    counts = {"checked": 0, "pruned": 0, "pending": 0, "expired": 0}
    try:
        client = get_redis()
        counts["expired"] = client.zremrangebyscore(KEY, "-inf", now - RECEIPT_MAX_AGE_SECONDS)
        waiting = 0
        for _ in range(MAX_BATCHES):
            due = _due_entries(client, now, waiting)
            if not due:
                break
            waiting += _settle(client, due, _fetch(list(due)), now, counts)
            if len(due) < BATCH:
                break
        counts["pending"] = waiting
    except redis.RedisError:
        logger.warning("expo receipts: the store is unavailable")
    return counts
