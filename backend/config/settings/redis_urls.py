"""Redis URL layout and the channel-layer config (no Django imports: settings modules use it).

One Redis server may serve everything in development, with a DIFFERENT database number per role
so that a flush or a key scan of one role never touches another:

    0 broker + Celery results     1 channel layer (WebSocket groups)
    2 Django cache (throttling)   3 application state (WS tickets, connection registry,
                                    debounce, Expo tickets, idempotency, attempts)

Eviction is a property of the SERVER, not of a database number: broker, channel layer and state
must live on a ``noeviction`` server (evicting a queued task or a ticket silently loses data),
while the cache may live on an ``allkeys-lru`` one. In production point ``CACHE_REDIS_URL`` at a
separate instance. Redis >= 6.2 is required (GETDEL).
"""

from urllib.parse import urlsplit, urlunsplit

DB_BROKER, DB_CHANNELS, DB_CACHE, DB_STATE = 0, 1, 2, 3

# Seconds. A dead or slow Redis must fail a call fast (the realtime publishers are fail-open) and
# never hang a request, a Celery task or the ASGI event loop.
SOCKET_TIMEOUT = 2
READ_TIMEOUT = 10  # channel layer only, see channel_layers()
# Seconds a channel-layer message may wait unread, and its per-channel backlog cap.
MESSAGE_EXPIRY = 10
CHANNEL_CAPACITY = 1000
# The group membership key of Redis channel layer expires after this long unless refreshed by
# group_add. A WebSocket therefore never lives longer than WS_MAX_AGE_SECONDS (12 h, close 4410),
# well inside this value: the client reconnects and subscribes again.
GROUP_EXPIRY = 86400


def with_db(url: str, db: int) -> str:
    """``url`` pointing at database ``db`` (rediss:// and credentials are kept)."""
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{db}"))


def channel_layers(url: str) -> dict:
    """CHANNEL_LAYERS for ``channels_redis`` with bounded socket timeouts and sane limits."""
    return {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {
                "hosts": [
                    {
                        "address": url,
                        # channels_redis receive() blocks in BZPOPMIN for up to 5 s (brpop_timeout)
                        # on this same pool: a read timeout below that would break every idle
                        # consumer. Sends are bounded separately (publishers wait_for, 2 s).
                        "socket_timeout": READ_TIMEOUT,
                        "socket_connect_timeout": SOCKET_TIMEOUT,
                    }
                ],
                "prefix": "habi",
                "expiry": MESSAGE_EXPIRY,
                "capacity": CHANNEL_CAPACITY,
                "group_expiry": GROUP_EXPIRY,
            },
        }
    }
