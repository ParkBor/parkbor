"""Per-user connection cap shared by all ASGI workers (Redis sorted set: member = channel name,
score = connect time). The newest ``WS_MAX_CONNECTIONS_PER_USER`` connections stay; older ones are
evicted. FAIL-OPEN: without Redis the cap is simply not enforced (the socket still works)."""

import logging
import time

import redis
from django.conf import settings

from apps.core.redis_client import get_redis

logger = logging.getLogger(__name__)

KEY_TTL_SECONDS = 3600  # refreshed by every heartbeat; a crashed worker's leftovers expire


def _key(user_id) -> str:
    return f"ws:conns:{user_id}"


def register(user_id, channel_name: str) -> list[str]:
    """Record a connection; return the channel names that must be closed to stay within the cap."""
    limit = settings.WS_MAX_CONNECTIONS_PER_USER
    try:
        client = get_redis()
        key = _key(user_id)
        pipe = client.pipeline()
        pipe.zadd(key, {channel_name: time.time()})
        pipe.expire(key, KEY_TTL_SECONDS)
        pipe.zcard(key)
        count = pipe.execute()[-1]
        if count <= limit:
            return []
        victims = client.zrange(key, 0, count - limit - 1)
        if victims:
            client.zrem(key, *victims)
        return [name for name in victims if name != channel_name]
    except redis.RedisError:
        logger.warning("ws connection cap not enforced: the store is unavailable")
        return []


def unregister(user_id, channel_name: str) -> None:
    try:
        get_redis().zrem(_key(user_id), channel_name)
    except redis.RedisError:
        logger.warning("ws connection registry not updated: the store is unavailable")


def touch(user_id) -> None:
    try:
        get_redis().expire(_key(user_id), KEY_TTL_SECONDS)
    except redis.RedisError:
        pass  # best effort; the next heartbeat tries again
