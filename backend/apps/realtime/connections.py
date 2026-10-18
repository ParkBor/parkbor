"""Per-user connection cap shared by all ASGI workers (Redis sorted set: member = channel name,
score = last heartbeat). The newest ``WS_MAX_CONNECTIONS_PER_USER`` connections stay; the others
are evicted. Registration is ONE Lua script, so concurrent connects of the same user cannot both
see room. Entries whose heartbeat stopped (a crashed worker) are dropped by the same script.

FAIL-OPEN: without Redis the cap is simply not enforced (the socket still works).
"""

import logging
import time

import redis
from django.conf import settings

from apps.core.redis_client import get_redis

logger = logging.getLogger(__name__)

KEY_TTL_SECONDS = 3600  # refreshed by every heartbeat; a crashed worker's leftovers expire
STALE_HEARTBEATS = 3  # an entry silent for this many heartbeat periods is dead

# KEYS[1] zset; ARGV: member, now, limit, key ttl, stale-before score.
# The newcomer's score is never below the newest existing one (worker clock skew, a thread delayed
# between time.time() and EVAL): a newcomer must not be the oldest and so evict ITSELF while its
# socket stays open and unregistered.
_REGISTER = """
local score = tonumber(ARGV[2])
local top = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
if top[2] and tonumber(top[2]) >= score then
  score = tonumber(top[2]) + 0.001
end
redis.call('ZADD', KEYS[1], score, ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[4])
local count = redis.call('ZCARD', KEYS[1])
local limit = tonumber(ARGV[3])
local victims = {}
if count > limit then
  victims = redis.call('ZRANGE', KEYS[1], 0, count - limit - 1)
  for _, victim in ipairs(victims) do redis.call('ZREM', KEYS[1], victim) end
end
return victims
"""


def _key(user_id) -> str:
    return f"ws:conns:{user_id}"


def _stale_after() -> float:
    return max(STALE_HEARTBEATS * settings.WS_HEARTBEAT_SECONDS, settings.WS_IDLE_TIMEOUT_SECONDS)


def register(user_id, channel_name: str, now: float | None = None) -> list[str]:
    """Record a connection; return the channel names that must be closed to stay within the cap
    (the caller's own name included, should it ever be chosen)."""
    now = time.time() if now is None else now
    try:
        victims = get_redis().eval(
            _REGISTER,
            1,
            _key(user_id),
            channel_name,
            now,
            settings.WS_MAX_CONNECTIONS_PER_USER,
            KEY_TTL_SECONDS,
            now - _stale_after(),
        )
    except redis.RedisError:
        logger.warning("ws connection cap not enforced: the store is unavailable")
        return []
    # Normally never the newcomer itself (see _REGISTER); if it ever is, it is returned too, so the
    # consumer tells its own channel to close rather than staying open and unregistered.
    return list(victims)


def unregister(user_id, channel_name: str) -> None:
    try:
        get_redis().zrem(_key(user_id), channel_name)
    except redis.RedisError:
        logger.warning("ws connection registry not updated: the store is unavailable")


def touch(user_id, channel_name: str, now: float | None = None) -> None:
    """Heartbeat: refresh this connection's score (only if still registered: XX) and the key TTL."""
    try:
        client = get_redis()
        key = _key(user_id)
        client.zadd(key, {channel_name: time.time() if now is None else now}, xx=True)
        client.expire(key, KEY_TTL_SECONDS)
    except redis.RedisError:
        pass  # best effort; the next heartbeat tries again
