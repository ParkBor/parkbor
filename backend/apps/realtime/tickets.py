"""One-time WebSocket tickets (ARCHITECTURE 12).

A JWT in the WebSocket URL would land in proxy / access logs, so the app first trades its JWT for
a ticket over HTTPS (``POST /ws/ticket``) and opens the socket with ``?ticket=``. A ticket is
128 bits of randomness, lives 30 seconds, is bound to one user and is deleted by the first use
(``GETDEL``): a logged ticket is already worthless. Redis only ever sees its SHA-256.
"""

import hashlib
import logging
import re
import secrets

import redis
from django.conf import settings

from apps.core.redis_client import get_redis

logger = logging.getLogger(__name__)

TICKET_BYTES = 16  # 128 bits
_TICKET_RE = re.compile(r"[A-Za-z0-9_-]{22,64}")
_KEY_PREFIX = "ws:ticket:"
_MAX_ATTEMPTS = 3


class TicketStoreUnavailable(Exception):  # noqa: N818
    """Redis could not be reached: fail closed (no ticket is issued or accepted)."""


def _key(ticket: str) -> str:
    return _KEY_PREFIX + hashlib.sha256(ticket.encode("ascii")).hexdigest()


def issue_ticket(user_id) -> str:
    ttl = settings.WS_TICKET_TTL_SECONDS
    try:
        client = get_redis()
        for _ in range(_MAX_ATTEMPTS):
            ticket = secrets.token_urlsafe(TICKET_BYTES)
            if client.set(_key(ticket), str(user_id), nx=True, ex=ttl):
                return ticket
    except redis.RedisError:
        logger.error("ws ticket: the store is unavailable")
        raise TicketStoreUnavailable from None
    raise TicketStoreUnavailable  # three collisions in a row: not a realistic outcome


def consume_ticket(ticket) -> str | None:
    """The user id the ticket was issued to, or None (unknown, used, expired or malformed)."""
    if not isinstance(ticket, str) or not _TICKET_RE.fullmatch(ticket):
        return None
    try:
        return get_redis().getdel(_key(ticket))
    except redis.RedisError:
        logger.error("ws ticket: the store is unavailable")
        raise TicketStoreUnavailable from None
