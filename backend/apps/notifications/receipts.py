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


def remember(ticket_id: str, token: str, now: float | None = None) -> None:
    if not ticket_id:
        return
    try:
        get_redis().zadd(KEY, {f"{ticket_id}|{token}": now if now is not None else time.time()})
    except redis.RedisError:
        logger.warning("expo receipts: could not remember a ticket")


def _due_entries(client, now: float) -> dict[str, tuple[str, str]]:
    """ticket id -> (token, raw entry) for the tickets old enough to have a receipt."""
    entries = client.zrangebyscore(KEY, 0, now - RECEIPT_DELAY_SECONDS, start=0, num=BATCH)
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


def check_receipts(now: float | None = None) -> dict[str, int]:
    """Read the receipts that are due; returns counts (checked / pruned / pending)."""
    now = now if now is not None else time.time()
    counts = {"checked": 0, "pruned": 0, "pending": 0}
    try:
        client = get_redis()
        due = _due_entries(client, now)
        receipts = _fetch(list(due))
        for ticket, (token, entry) in due.items():
            receipt = receipts.get(ticket)
            if receipt is None:
                if (client.zscore(KEY, entry) or 0) < now - RECEIPT_MAX_AGE_SECONDS:
                    client.zrem(KEY, entry)  # Expo no longer has it
                else:
                    counts["pending"] += 1
                continue
            counts["checked"] += 1
            if receipt.outcome is PushOutcome.INVALID_TOKEN:
                counts["pruned"] += Device.objects.filter(expo_push_token=token).delete()[0]
            client.zrem(KEY, entry)
    except redis.RedisError:
        logger.warning("expo receipts: the store is unavailable")
    return counts
