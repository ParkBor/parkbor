"""WebSocket consumer for live availability (ARCHITECTURE 12).

Protocol (JSON text frames, details in docs/ARCHITECTURE.md section 12):

    client -> server  {"type":"auth","ticket":...}            only if no ``?ticket=`` was given
                      {"type":"subscribe"|"unsubscribe","groups":[{"kind","id"}, ...]}
                      {"type":"ping"} | {"type":"pong"}
    server -> client  {"type":"ready"} | {"type":"subscribed"|"unsubscribed", ...}
                      {"type":"availability"|"slot_status"|"booking_status", ...}
                      {"type":"ping"} | {"type":"pong"} | {"type":"error","code":...}

Close codes: 4400 bad frame, 4401 not authenticated, 1009 too big, 4408 idle, 4409 replaced by a
newer connection, 4410 maximum age reached (reconnect), 4429 too many messages, 1011 internal
error (fail closed), 1013 try again later (ticket store down).

The consumer never trusts a client id: group names come from ``groups.py`` (strict parsing), a lot
subscription needs an ACTIVE lot, the operator feed needs ``access.operable_lots`` (checked on
every subscribe and on every heartbeat), and the personal ``user_<id>`` group is joined by the
server for the authenticated user only.

Robustness: whatever happens (a crash in a handler, in the heartbeat, a cancelled task) the
connection's registry entry, channel-layer groups and background task are released in
``__call__``'s ``finally``; a failure of the periodic re-check closes the socket (fail CLOSED:
a connection whose permissions cannot be verified must not stay open).
"""

import asyncio
import contextlib
import json
import logging
import time
from urllib.parse import parse_qs

from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings

from . import connections, groups, queries, tickets
from .ratelimit import TokenBucket

logger = logging.getLogger(__name__)

CLOSE_BAD_FRAME = 4400
CLOSE_UNAUTHENTICATED = 4401
CLOSE_IDLE = 4408
CLOSE_REPLACED = 4409
CLOSE_MAX_AGE = 4410
CLOSE_RATE_LIMITED = 4429
CLOSE_TOO_BIG = 1009
CLOSE_INTERNAL = 1011
CLOSE_TRY_AGAIN = 1013

MAX_ECHOED_ID_CHARS = 64  # rejected ids are echoed back truncated: never reflect client text
MAX_DENIED_ENTRIES = 1000  # the per-connection negative cache never grows beyond this


def _echo(value) -> str:
    return value[:MAX_ECHOED_ID_CHARS] if isinstance(value, str) else ""


class AvailabilityConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.user_id: str | None = None
        self.joined: dict[str, tuple[str, str]] = {}  # group name -> (kind, id)
        self.denied: dict[tuple[str, str], float] = {}  # (kind, id) -> refused until (monotonic)
        self.bucket = TokenBucket(settings.WS_MESSAGES_PER_SECOND)
        self.connected_at = time.monotonic()
        self.last_inbound = self.connected_at
        self.background: asyncio.Task | None = None
        self.registered = False
        self._cleaned = False

    # ---- lifecycle ---------------------------------------------------------------------------

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # also on a crash or a cancelled task: nothing may stay registered or subscribed
            await self._cleanup()

    async def connect(self):
        await self.accept()  # always accept first: a refusal before accept hides the close code
        query = parse_qs(self.scope.get("query_string", b"").decode("latin1"))
        offered = query.get("ticket", [])
        if len(offered) == 1:
            await self._authenticate(offered[0])
        elif offered:
            await self.close(code=CLOSE_UNAUTHENTICATED)
        else:
            self.background = asyncio.create_task(self._auth_deadline())

    async def disconnect(self, code):
        await self._cleanup()

    async def _cleanup(self):
        """Release everything this connection holds. Idempotent."""
        if self._cleaned:
            return
        self._cleaned = True
        task, self.background = self.background, None
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if self.user_id is None:
            return
        layer = getattr(self, "channel_layer", None)
        name = getattr(self, "channel_name", None)
        if layer is not None and name is not None:
            for group in [*self.joined, groups.user_group(self.user_id)]:
                with contextlib.suppress(Exception):
                    await layer.group_discard(group, name)
        self.joined.clear()
        if self.registered and name is not None:
            with contextlib.suppress(Exception):
                await sync_to_async(connections.unregister, thread_sensitive=False)(
                    self.user_id, name
                )

    # ---- authentication ---------------------------------------------------------------------

    async def _auth_deadline(self):
        await asyncio.sleep(settings.WS_AUTH_TIMEOUT_SECONDS)
        if self.user_id is None:
            await self.close(code=CLOSE_UNAUTHENTICATED)

    async def _authenticate(self, ticket) -> None:
        try:
            owner = await sync_to_async(tickets.consume_ticket, thread_sensitive=False)(ticket)
        except tickets.TicketStoreUnavailable:
            await self.close(code=CLOSE_TRY_AGAIN)
            return
        if not await self._owner_is_active(owner):
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return
        if self.background is not None:
            self.background.cancel()
        self.user_id = str(groups.parse_uuid(owner))
        await self.channel_layer.group_add(groups.user_group(self.user_id), self.channel_name)
        await self._enforce_connection_cap()
        self.background = asyncio.create_task(self._heartbeat())
        await self._send({"type": "ready"})

    @staticmethod
    async def _owner_is_active(owner) -> bool:
        if not owner:
            return False
        try:
            groups.parse_uuid(owner)
        except groups.InvalidGroup:
            return False
        return await database_sync_to_async(queries.user_is_active)(owner)

    async def _enforce_connection_cap(self):
        victims = await sync_to_async(connections.register, thread_sensitive=False)(
            self.user_id, self.channel_name
        )
        self.registered = True
        for channel in victims:
            with contextlib.suppress(Exception):
                await self.channel_layer.send(channel, {"type": "ws.evict"})

    # ---- inbound ----------------------------------------------------------------------------

    async def receive(self, text_data=None, bytes_data=None):
        self.last_inbound = time.monotonic()
        if text_data is None:
            await self.close(code=CLOSE_BAD_FRAME)
            return
        limit = settings.WS_MAX_MESSAGE_BYTES
        if len(text_data) > limit or len(text_data.encode("utf-8")) > limit:
            await self.close(code=CLOSE_TOO_BIG)
            return
        if not self.bucket.allow():
            await self.close(code=CLOSE_RATE_LIMITED)
            return
        message = self._parse(text_data)
        if message is None:
            await self.close(code=CLOSE_BAD_FRAME)
            return
        # Work is charged per ELEMENT: a message naming 50 groups costs 50 tokens (capped at the
        # bucket size), not one, or ten messages a second would be 500 database lookups a second.
        extra = self._element_count(message) - 1
        if extra > 0 and not self.bucket.allow(extra):
            await self.close(code=CLOSE_RATE_LIMITED)
            return
        await self._dispatch(message)

    @staticmethod
    def _parse(text: str) -> dict | None:
        try:
            message = json.loads(text)
        except ValueError:
            return None
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            return None
        return message

    @staticmethod
    def _element_count(message: dict) -> int:
        items = message.get("groups")
        return (
            len(items)
            if message["type"] in ("subscribe", "unsubscribe") and isinstance(items, list)
            else 1
        )

    async def _dispatch(self, message: dict):
        kind = message["type"]
        if self.user_id is None:
            if kind == "auth":
                await self._authenticate(message.get("ticket"))
            else:
                await self.close(code=CLOSE_UNAUTHENTICATED)
            return
        handler = {
            "subscribe": self._subscribe,
            "unsubscribe": self._unsubscribe,
            "ping": self._ping,
            "pong": self._noop,
            "auth": self._noop,  # already authenticated: ignored
        }.get(kind)
        if handler is None:
            await self._send({"type": "error", "code": "unknown_type"})
            return
        await handler(message)

    async def _noop(self, message):
        return None

    async def _ping(self, message):
        await self._send({"type": "pong"})

    # ---- subscribe / unsubscribe ----------------------------------------------------------------

    def _requested_items(self, message) -> list | None:
        items = message.get("groups")
        if not isinstance(items, list) or len(items) > settings.WS_MAX_GROUPS_PER_CONNECTION:
            return None
        return items

    @staticmethod
    def _resolve(item) -> tuple[str, str, str] | str:
        """(kind, id, group name) of a request item, or the rejection code."""
        if not isinstance(item, dict) or item.get("kind") not in groups.CLIENT_KINDS:
            return "invalid_kind"
        kind, raw = item["kind"], item.get("id")
        try:
            if kind == groups.KIND_GEO:
                cell = groups.parse_geohash(raw)
                return kind, cell, groups.geo_group(cell)
            ident = str(groups.parse_uuid(raw))
        except groups.InvalidGroup:
            return "invalid_group"
        name = groups.lot_group(ident) if kind == groups.KIND_LOT else groups.operator_group(ident)
        return kind, ident, name

    def _is_denied(self, kind: str, ident: str) -> bool:
        until = self.denied.get((kind, ident))
        if until is None:
            return False
        if until <= time.monotonic():
            del self.denied[(kind, ident)]
            return False
        return True

    def _deny(self, kind: str, ident: str) -> None:
        if len(self.denied) >= MAX_DENIED_ENTRIES:
            self.denied.clear()
        self.denied[(kind, ident)] = time.monotonic() + settings.WS_NEGATIVE_CACHE_SECONDS

    async def _lookup(self, resolved: list) -> tuple[dict, set | None]:
        """The database answers for a whole message: lot snapshots (ACTIVE lots only) and the
        operable operator lots. ``None`` for the second value: the account is no longer active."""
        lots, operator = set(), set()
        for outcome in resolved:
            if isinstance(outcome, str):
                continue
            kind, ident, name = outcome
            if name in self.joined or self._is_denied(kind, ident):
                continue
            if kind == groups.KIND_LOT:
                lots.add(ident)
            elif kind == groups.KIND_OPERATOR_LOT:
                operator.add(ident)
        snapshots = await database_sync_to_async(queries.lots_snapshot)(lots) if lots else {}
        allowed: set | None = set()
        if operator:
            alive, allowed = await database_sync_to_async(queries.operable_lot_ids)(
                self.user_id, operator
            )
            allowed = allowed if alive else None
        return snapshots, allowed

    async def _subscribe(self, message):
        items = self._requested_items(message)
        if items is None:
            await self._send({"type": "error", "code": "invalid_groups"})
            return
        resolved = [self._resolve(item) for item in items]
        snapshots, operable = await self._lookup(resolved)
        if operable is None:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return
        accepted, rejected, fresh = [], [], []
        for item, outcome in zip(items, resolved, strict=True):
            if isinstance(outcome, str):
                rejected.append(self._rejection(item, outcome))
                continue
            kind, ident, name = outcome
            entry = {"kind": kind, "id": ident}
            if name in self.joined:
                accepted.append(entry)
            elif len(self.joined) >= settings.WS_MAX_GROUPS_PER_CONNECTION:
                rejected.append({**entry, "code": "too_many_groups"})
            elif not self._may_join(kind, ident, snapshots, operable):
                self._deny(kind, ident)
                rejected.append({**entry, "code": "not_found"})
            else:
                await self.channel_layer.group_add(name, self.channel_name)
                self.joined[name] = (kind, ident)
                accepted.append(entry)
                if kind == groups.KIND_LOT:
                    fresh.append(snapshots[ident])
        await self._send({"type": "subscribed", "groups": accepted, "rejected": rejected})
        for snapshot in fresh:
            await self._send(queries.availability_payload(snapshot))

    def _may_join(self, kind: str, ident: str, snapshots: dict, operable: set) -> bool:
        if kind == groups.KIND_GEO:
            return True
        if self._is_denied(kind, ident):
            return False
        if kind == groups.KIND_LOT:
            return ident in snapshots
        return ident in operable

    @staticmethod
    def _rejection(item, code: str) -> dict:
        data = item if isinstance(item, dict) else {}
        return {"kind": _echo(data.get("kind")), "id": _echo(data.get("id")), "code": code}

    async def _unsubscribe(self, message):
        items = self._requested_items(message)
        if items is None:
            await self._send({"type": "error", "code": "invalid_groups"})
            return
        left = []
        for item in items:
            outcome = self._resolve(item)
            if isinstance(outcome, str):
                continue
            kind, ident, name = outcome
            if self.joined.pop(name, None) is None:
                continue
            await self.channel_layer.group_discard(name, self.channel_name)
            left.append({"kind": kind, "id": ident})
        await self._send({"type": "unsubscribed", "groups": left})

    # ---- heartbeat ------------------------------------------------------------------------------

    async def _heartbeat(self):
        """Ping, idle / age limits and permission re-check. A failure of the re-check closes the
        connection (1011): permissions that cannot be verified are not assumed."""
        try:
            while True:
                await asyncio.sleep(settings.WS_HEARTBEAT_SECONDS)
                if not await self._tick():
                    return
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - fail closed, whatever broke (database, Redis, layer)
            logger.exception("ws heartbeat failed: closing the connection")
            with contextlib.suppress(Exception):
                await self.close(code=CLOSE_INTERNAL)

    async def _tick(self) -> bool:
        """One heartbeat. False when the connection was closed."""
        now = time.monotonic()
        if now - self.last_inbound > settings.WS_IDLE_TIMEOUT_SECONDS:
            await self.close(code=CLOSE_IDLE)
            return False
        if now - self.connected_at > settings.WS_MAX_AGE_SECONDS:
            await self.close(code=CLOSE_MAX_AGE)
            return False
        if not await self._revalidate():
            return False
        await sync_to_async(connections.touch, thread_sensitive=False)(
            self.user_id, self.channel_name
        )
        await self._send({"type": "ping"})
        return True

    async def _revalidate(self) -> bool:
        """Re-check the account and, in ONE query, every joined operator lot. False: closed."""
        operator = {
            name: ident
            for name, (kind, ident) in self.joined.items()
            if kind == groups.KIND_OPERATOR_LOT
        }
        if operator:
            alive, allowed = await database_sync_to_async(queries.operable_lot_ids)(
                self.user_id, operator.values()
            )
        else:
            alive = await database_sync_to_async(queries.user_is_active)(self.user_id)
            allowed = set()
        if not alive:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return False
        for name, ident in operator.items():
            # pop(): an unsubscribe may have removed it while the query was running
            if ident not in allowed and self.joined.pop(name, None) is not None:
                await self.channel_layer.group_discard(name, self.channel_name)
                await self._send(
                    {
                        "type": "unsubscribed",
                        "groups": [{"kind": groups.KIND_OPERATOR_LOT, "id": ident}],
                    }
                )
        return True

    # ---- channel-layer events -------------------------------------------------------------------

    async def realtime_event(self, event):
        """A publisher message for one of our groups (``publishers.EVENT_TYPE``)."""
        await self._send(event["payload"])

    async def ws_evict(self, event):
        """A newer connection of the same user pushed this one over the per-user cap."""
        await self.close(code=CLOSE_REPLACED)

    async def _send(self, payload: dict):
        await self.send(text_data=json.dumps(payload, separators=(",", ":")))
