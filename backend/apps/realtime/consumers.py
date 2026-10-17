"""WebSocket consumer for live availability (ARCHITECTURE 12).

Protocol (JSON text frames, details in docs/ARCHITECTURE.md section 12):

    client -> server  {"type":"auth","ticket":...}            only if no ``?ticket=`` was given
                      {"type":"subscribe"|"unsubscribe","groups":[{"kind","id"}, ...]}
                      {"type":"ping"} | {"type":"pong"}
    server -> client  {"type":"ready"} | {"type":"subscribed"|"unsubscribed", ...}
                      {"type":"availability"|"slot_status"|"booking_status", ...}
                      {"type":"ping"} | {"type":"pong"} | {"type":"error","code":...}

Close codes: 4400 bad frame, 4401 not authenticated, 1009 too big, 4408 idle, 4409 replaced by a
newer connection, 4429 too many messages, 1013 try again later (ticket store down).

The consumer never trusts a client id: group names come from ``groups.py`` (strict parsing), a lot
subscription needs an ACTIVE lot, the operator feed needs ``access.get_operable_lot`` (checked on
every subscribe and on every heartbeat), and the personal ``user_<id>`` group is joined by the
server for the authenticated user only.
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
CLOSE_RATE_LIMITED = 4429
CLOSE_TOO_BIG = 1009
CLOSE_TRY_AGAIN = 1013

MAX_ECHOED_ID_CHARS = 64  # rejected ids are echoed back truncated: never reflect client text


def _echo(value) -> str:
    return value[:MAX_ECHOED_ID_CHARS] if isinstance(value, str) else ""


class AvailabilityConsumer(AsyncWebsocketConsumer):
    # ---- lifecycle ---------------------------------------------------------------------------

    async def connect(self):
        self.user_id: str | None = None
        self.joined: dict[str, tuple[str, str]] = {}  # group name -> (kind, id)
        self.bucket = TokenBucket(settings.WS_MESSAGES_PER_SECOND)
        self.last_inbound = time.monotonic()
        self.background: asyncio.Task | None = None
        self.registered = False
        await self.accept()  # always accept first: a refusal before accept hides the close code
        tickets_in_url = parse_qs(self.scope.get("query_string", b"").decode("latin1")).get(
            "ticket", []
        )
        if len(tickets_in_url) == 1:
            await self._authenticate(tickets_in_url[0])
        elif tickets_in_url:
            await self.close(code=CLOSE_UNAUTHENTICATED)
        else:
            self.background = asyncio.create_task(self._auth_deadline())

    async def disconnect(self, code):
        if self.background is not None:
            self.background.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.background
        if self.user_id is not None:
            await self._leave_all()
            if self.registered:
                await sync_to_async(connections.unregister, thread_sensitive=False)(
                    self.user_id, self.channel_name
                )

    async def _leave_all(self):
        for name in [*self.joined, groups.user_group(self.user_id)]:
            with contextlib.suppress(Exception):
                await self.channel_layer.group_discard(name, self.channel_name)
        self.joined.clear()

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
        user = await database_sync_to_async(queries.active_user)(owner) if owner else None
        if user is None:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return
        if self.background is not None:
            self.background.cancel()
        self.user_id = str(user.pk)
        await self.channel_layer.group_add(groups.user_group(user.pk), self.channel_name)
        await self._enforce_connection_cap()
        self.background = asyncio.create_task(self._heartbeat())
        await self._send({"type": "ready"})

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

    async def _subscribe(self, message):
        items = self._requested_items(message)
        if items is None:
            await self._send({"type": "error", "code": "invalid_groups"})
            return
        accepted, rejected, snapshots = [], [], []
        for item in items:
            outcome = self._resolve(item)
            if isinstance(outcome, str):
                rejected.append(self._rejection(item, outcome))
                continue
            kind, ident, name = outcome
            if name in self.joined:
                accepted.append({"kind": kind, "id": ident})
                continue
            if len(self.joined) >= settings.WS_MAX_GROUPS_PER_CONNECTION:
                rejected.append({"kind": kind, "id": ident, "code": "too_many_groups"})
                continue
            if not await self._may_join(kind, ident):
                rejected.append({"kind": kind, "id": ident, "code": "not_found"})
                continue
            await self.channel_layer.group_add(name, self.channel_name)
            self.joined[name] = (kind, ident)
            accepted.append({"kind": kind, "id": ident})
            if kind == groups.KIND_LOT:
                snapshots.append(ident)
        await self._send({"type": "subscribed", "groups": accepted, "rejected": rejected})
        for lot_id in snapshots:
            await self._send_snapshot(lot_id)

    @staticmethod
    def _rejection(item, code: str) -> dict:
        data = item if isinstance(item, dict) else {}
        return {"kind": _echo(data.get("kind")), "id": _echo(data.get("id")), "code": code}

    async def _may_join(self, kind: str, ident: str) -> bool:
        if kind == groups.KIND_GEO:
            return True
        if kind == groups.KIND_LOT:
            return await database_sync_to_async(queries.lot_is_subscribable)(ident)
        return await database_sync_to_async(queries.operates_lot)(self.user_id, ident)

    async def _send_snapshot(self, lot_id: str):
        snapshot = await database_sync_to_async(queries.availability_snapshot)(lot_id)
        if snapshot is None:
            return
        await self._send(
            {
                "type": "availability",
                "lot_id": snapshot["lot_id"],
                "free_slots": snapshot["free_slots"],
                "total_slots": snapshot["total_slots"],
                "ts": queries.timestamp(),
            }
        )

    async def _unsubscribe(self, message):
        items = self._requested_items(message)
        if items is None:
            await self._send({"type": "error", "code": "invalid_groups"})
            return
        left = []
        for item in items:
            outcome = self._resolve(item)
            if isinstance(outcome, str) or outcome[2] not in self.joined:
                continue
            kind, ident, name = outcome
            await self.channel_layer.group_discard(name, self.channel_name)
            del self.joined[name]
            left.append({"kind": kind, "id": ident})
        await self._send({"type": "unsubscribed", "groups": left})

    # ---- heartbeat ------------------------------------------------------------------------------

    async def _heartbeat(self):
        interval = settings.WS_HEARTBEAT_SECONDS
        while True:
            await asyncio.sleep(interval)
            if time.monotonic() - self.last_inbound > settings.WS_IDLE_TIMEOUT_SECONDS:
                await self.close(code=CLOSE_IDLE)
                return
            if not await self._revalidate():
                return
            await sync_to_async(connections.touch, thread_sensitive=False)(self.user_id)
            await self._send({"type": "ping"})

    async def _revalidate(self) -> bool:
        """Re-check the account and every operator feed. False: the connection was closed."""
        user = await database_sync_to_async(queries.active_user)(self.user_id)
        if user is None:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return False
        for name, (kind, ident) in list(self.joined.items()):
            if kind != groups.KIND_OPERATOR_LOT:
                continue
            if not await database_sync_to_async(queries.operates_lot)(self.user_id, ident):
                await self.channel_layer.group_discard(name, self.channel_name)
                del self.joined[name]
                await self._send({"type": "unsubscribed", "groups": [{"kind": kind, "id": ident}]})
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
