"""Booking state machine (ARCHITECTURE 6.2). Pure: no DB access.

``Booking.status`` may only change through ``apps.bookings.services``; the model refuses any
other write unless it happens inside ``status_write_allowed()`` (see models.Booking.save and
BookingQuerySet.update).
"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from django.db import models

from apps.core.exceptions import InvalidTransition


class BookingStatus(models.TextChoices):
    PENDING_PAYMENT = "PENDING_PAYMENT", "Pending payment"
    CONFIRMED = "CONFIRMED", "Confirmed"
    ACTIVE = "ACTIVE", "Active"
    OVERSTAY = "OVERSTAY", "Overstay"
    COMPLETED = "COMPLETED", "Completed"
    CANCELLED = "CANCELLED", "Cancelled"
    EXPIRED = "EXPIRED", "Expired"
    NO_SHOW = "NO_SHOW", "No-show"


class BookingKind(models.TextChoices):
    ONLINE = "ONLINE", "Online booking"
    WALK_IN = "WALK_IN", "Walk-in (registered at the gate)"


class OverstayStatus(models.TextChoices):
    """Money owed for time parked past the booking end; collected in cash at the gate (Step 9)."""

    NONE = "none", "No overstay charge"
    DUE = "due", "Charge not collected yet"
    COLLECTED = "collected", "Collected at the gate"
    WAIVED = "waived", "Waived by an administrator"


S = BookingStatus

# source -> allowed targets. PENDING_PAYMENT -> CANCELLED is the driver abandoning the payment
# page (no money moved); everything else follows the 6.2 diagram.
TRANSITIONS: dict[str, frozenset[str]] = {
    S.PENDING_PAYMENT: frozenset({S.CONFIRMED, S.EXPIRED, S.CANCELLED}),
    S.CONFIRMED: frozenset({S.ACTIVE, S.CANCELLED, S.NO_SHOW}),
    S.ACTIVE: frozenset({S.COMPLETED, S.OVERSTAY}),
    S.OVERSTAY: frozenset({S.COMPLETED}),
    S.COMPLETED: frozenset(),
    S.CANCELLED: frozenset(),
    S.EXPIRED: frozenset(),
    S.NO_SHOW: frozenset(),
}

# Statuses that occupy the slot in time: exactly the WHERE of the EXCLUDE constraint (7.1).
BLOCKING_STATUSES: tuple[str, ...] = (
    S.PENDING_PAYMENT,
    S.CONFIRMED,
    S.ACTIVE,
    S.OVERSTAY,
)
TERMINAL_STATUSES: frozenset[str] = frozenset({S.COMPLETED, S.CANCELLED, S.EXPIRED, S.NO_SHOW})

# Driver-facing groups for GET /bookings?scope=
SCOPE_STATUSES: dict[str, tuple[str, ...]] = {
    "active": (S.ACTIVE, S.OVERSTAY),
    "upcoming": (S.PENDING_PAYMENT, S.CONFIRMED),
    "history": (S.COMPLETED, S.CANCELLED, S.EXPIRED, S.NO_SHOW),
}


def can_transition(source: str, target: str) -> bool:
    return target in TRANSITIONS.get(source, frozenset())


def assert_transition(source: str, target: str) -> None:
    if not can_transition(source, target):
        raise InvalidTransition(f"Cannot change a booking from {source} to {target}.")


_STATUS_WRITE_ALLOWED: ContextVar[bool] = ContextVar("booking_status_write_allowed", default=False)


@contextmanager
def status_write_allowed() -> Iterator[None]:
    """Open the model-level guard. Only services.py (and test factories) use this."""
    token = _STATUS_WRITE_ALLOWED.set(True)
    try:
        yield
    finally:
        _STATUS_WRITE_ALLOWED.reset(token)


def status_write_is_allowed() -> bool:
    return _STATUS_WRITE_ALLOWED.get()
