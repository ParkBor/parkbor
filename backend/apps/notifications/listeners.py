"""Event listeners: translate booking / refund facts into ``notify()`` calls.

They run after the originating transaction committed (``apps.core.events``), and a listener that
raises is logged by the registry, never propagated. A walk-in has no account (``user_id`` None):
there is nobody to message, so every listener returns quietly for it.
"""

import logging

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus
from apps.payments.models import RefundStatus

from . import events as ev
from .dispatcher import notify

logger = logging.getLogger(__name__)

_BY_BOOKING_STATUS = {
    BookingStatus.CONFIRMED: ev.BOOKING_CONFIRMED,
    BookingStatus.EXPIRED: ev.BOOKING_EXPIRED,
    BookingStatus.CANCELLED: ev.BOOKING_CANCELLED,
    BookingStatus.NO_SHOW: ev.NO_SHOW,
}
_BY_REFUND_STATUS = {
    RefundStatus.DONE: ev.REFUND_DONE,
    RefundStatus.MANUAL: ev.REFUND_MANUAL,
    RefundStatus.FAILED: ev.REFUND_FAILED,
}


def on_booking_status(*, booking_id, user_id, lot_id, status, previous) -> None:
    event = _BY_BOOKING_STATUS.get(status)
    if event is None or user_id is None:
        return
    notify(user_id, event, {"booking_id": booking_id}, dedupe_key=booking_id)


def on_overstay_detected(*, booking_id, lot_id, user_id=None) -> None:
    if user_id is None:  # a walk-in: the operator screen is the only audience
        return
    notify(user_id, ev.OVERSTAY_DETECTED, {"booking_id": booking_id}, dedupe_key=booking_id)


def _driver_of(booking_id):
    return Booking.objects.filter(pk=booking_id).values_list("user_id", flat=True).first()


def on_slot_reassigned(*, booking_id, old_slot_id, new_slot_id, lot_id) -> None:
    from apps.parking.models import Slot

    user_id = _driver_of(booking_id)
    if user_id is None:
        return
    code = Slot.objects.filter(pk=new_slot_id).values_list("code", flat=True).first() or ""
    # A booking may be moved more than once: one message per destination slot.
    notify(
        user_id,
        ev.SLOT_REASSIGNED,
        {"booking_id": booking_id, "slot": code},
        dedupe_key=f"{booking_id}:{new_slot_id}",
    )


def on_overstay_conflict(*, booking_id, lot_id) -> None:
    """Only the waiting driver is told (the lot owner sees it on the operator screen)."""
    user_id = _driver_of(booking_id)
    if user_id is None:
        return
    notify(user_id, ev.OVERSTAY_CONFLICT, {"booking_id": booking_id}, dedupe_key=booking_id)


def on_refund_final(*, refund_id, booking_id, user_id, status, amount) -> None:
    event = _BY_REFUND_STATUS.get(status)
    if event is None or user_id is None:
        return
    notify(
        user_id,
        event,
        {"booking_id": booking_id, "amount": amount},
        dedupe_key=refund_id,
    )
