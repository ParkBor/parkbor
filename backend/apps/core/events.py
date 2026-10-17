"""Tiny in-process event registry: lets ``bookings`` / ``payments`` announce facts without
importing ``realtime`` or ``notifications`` (no import cycles, nothing to mock in their tests).

Listeners run synchronously in the emitter's thread, always AFTER the originating transaction
committed (emitters call ``emit`` from ``transaction.on_commit``). A listener that raises is
logged and never reaches the emitter: a broken WebSocket or broker must not undo a booking.
"""

import logging
from collections import defaultdict
from collections.abc import Callable

logger = logging.getLogger(__name__)

_listeners: dict[str, list[Callable[..., None]]] = defaultdict(list)


def subscribe(event: str, listener: Callable[..., None]) -> None:
    """Register ``listener`` for ``event`` (idempotent: ``ready()`` may run twice in tests)."""
    if listener not in _listeners[event]:
        _listeners[event].append(listener)


def unsubscribe(event: str, listener: Callable[..., None]) -> None:
    if listener in _listeners[event]:
        _listeners[event].remove(listener)


def emit(event: str, /, **payload) -> None:
    for listener in tuple(_listeners.get(event, ())):
        try:
            listener(**payload)
        except Exception:  # noqa: BLE001 - the emitter's work is already committed
            logger.exception("listener %s for event %s failed", _name(listener), event)


def _name(listener: Callable[..., None]) -> str:
    return getattr(listener, "__qualname__", repr(type(listener)))
