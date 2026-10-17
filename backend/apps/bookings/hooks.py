"""Integration points between bookings and the realtime / notifications apps.

Every hook is called through ``transaction.on_commit`` and announces its fact on the in-process
event registry (``apps.core.events``); ``realtime`` and ``notifications`` subscribe in their
``AppConfig.ready``. Bookings therefore never imports them, and a listener failure is logged by
the registry and never reaches the booking flow.
"""

import logging

from apps.core import events
from apps.core.exceptions import ServiceUnavailableError

logger = logging.getLogger(__name__)


def publish_availability_changed(lot_id) -> None:
    """Tell WebSocket subscribers that a lot's availability changed (ARCHITECTURE 12).

    Called via ``transaction.on_commit`` so listeners never see uncommitted state; the realtime
    app broadcasts the freshly read counters to ``lot_<id>`` and ``geo_<geohash5>``.
    """
    events.emit("availability_changed", lot_id=lot_id)


def booking_status_changed(booking_id, user_id, lot_id, status, previous) -> None:
    """A booking moved to ``status`` (after commit). ``user_id`` is None for a walk-in."""
    events.emit(
        "booking_status",
        booking_id=booking_id,
        user_id=user_id,
        lot_id=lot_id,
        status=status,
        previous=previous,
    )


def publish_slot_status(lot_id, slot_id, status) -> None:
    """A slot's PHYSICAL status changed (check-in/out, walk-in, operator PATCH; after commit)."""
    events.emit("slot_status", lot_id=lot_id, slot_id=slot_id, status=status)


def overstay_detected(booking_id, lot_id, user_id=None) -> None:
    """A parked car outstayed its booking (ACTIVE -> OVERSTAY; ARCHITECTURE 10.7).

    ``user_id`` is None for a walk-in (no account): there is nobody to notify but the operator
    screen / the lot, so a notifier must treat None as "no driver to message".

    The notifications app warns the driver (push / Telegram) when ``user_id`` is set. Called via
    ``transaction.on_commit``.
    """
    logger.info(
        "overstay detected: booking %s in lot %s, driver %s",
        booking_id,
        lot_id,
        user_id if user_id is not None else "none (walk-in)",
    )
    events.emit("overstay_detected", booking_id=booking_id, lot_id=lot_id, user_id=user_id)


def slot_reassigned(booking_id, old_slot_id, new_slot_id, lot_id) -> None:
    """A CONFIRMED booking was moved to another slot because an overstaying car blocks its own.

    The notifications app tells the booking's driver the new slot code (the QR stays valid: it
    names the lot, not the slot).
    """
    logger.info(
        "booking %s moved from slot %s to %s (lot %s)",
        booking_id,
        old_slot_id,
        new_slot_id,
        lot_id,
    )
    events.emit(
        "slot_reassigned",
        booking_id=booking_id,
        old_slot_id=old_slot_id,
        new_slot_id=new_slot_id,
        lot_id=lot_id,
    )


def overstay_conflict(booking_id, lot_id) -> None:
    """An overstaying car blocks this booking and no other slot is free.

    The notifications app warns the booking's driver (only the driver).
    """
    logger.warning(
        "booking %s in lot %s is blocked by an overstaying car and no slot is free",
        booking_id,
        lot_id,
    )
    events.emit("overstay_conflict", booking_id=booking_id, lot_id=lot_id)


# The payments app registers itself here (``PaymentsConfig.ready``), so bookings never imports it
# (no import cycle): ``cancel_booking`` hands a due refund to whoever is registered.
_refund_handler = None


def set_refund_handler(handler) -> None:
    global _refund_handler  # noqa: PLW0603
    _refund_handler = handler


class RefundHandlerMissing(ServiceUnavailableError):
    """Payments did not register its handler: cancelling a PAID booking must fail (and roll
    back), never succeed without a refund record."""

    default_detail = "Refunds are temporarily unavailable."
    default_code = "refund_handler_missing"


def create_refund(booking, amount):
    """Create the refund for a cancelled paid booking (inside the cancel transaction). FAILS
    CLOSED: without a handler the cancel is refused instead of silently dropping the refund."""
    if _refund_handler is None:
        logger.error("no refund handler registered: refusing to cancel paid booking %s", booking.pk)
        raise RefundHandlerMissing
    return _refund_handler(booking, amount)
