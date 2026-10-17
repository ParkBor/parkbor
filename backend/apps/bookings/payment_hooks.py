"""Booking operations the payments app drives (Step 8): confirming under the caller's locks,
the payment-time hold extension, the provider-initiated cancel and history lines.

Split out of ``services.py`` to keep that file cohesive. It is imported by ``services`` itself
(at the END of that module, which re-exports these names); import ``services``, never this module
directly. Everything here uses the same lock order and ``_apply_transition`` as the rest.
"""

from datetime import datetime, timedelta
from decimal import Decimal

from django.db import transaction

from . import services as core
from .conf import get_config
from .models import Booking
from .state import BookingStatus


def confirm_locked(booking: Booking, *, paid_amount: Decimal) -> Booking:
    """PENDING_PAYMENT -> CONFIRMED for a booking whose lot and row locks the CALLER holds
    (``confirm_booking`` and the payment webhooks). Raises ``InvalidTransition`` if the booking
    is no longer PENDING_PAYMENT, ``ValueError`` for an impossible amount."""
    if not Decimal(0) <= paid_amount <= booking.amount:
        raise ValueError("paid_amount must be between 0 and the booking amount")
    return core._apply_transition(
        booking,
        BookingStatus.CONFIRMED,
        actor=None,
        reason="payment_confirmed",
        audit_action="booking.confirm",
        fields={"paid_amount": paid_amount},
        meta={"paid_amount": str(paid_amount)},
    )


@core._retrying
@transaction.atomic
def confirm_booking(booking_id, *, paid_amount: Decimal, now: datetime | None = None) -> Booking:
    """PENDING_PAYMENT -> CONFIRMED after the provider collected `paid_amount`.

    Accepted even when the hold has just run out but the sweep has not expired the booking yet
    (the money is already taken); an EXPIRED booking is refused (InvalidTransition) and the
    payment must be refunded (payments app). The payment webhooks call ``confirm_locked``
    inside their own transaction, under the same locks.
    """
    _lot, booking = core._lock_lot_and_booking(booking_id)
    return confirm_locked(booking, paid_amount=paid_amount)


def log_booking_event(booking: Booking, *, reason: str, meta: dict | None = None) -> None:
    """Record a notable non-transition fact (payment started, refund sent, ...) in the booking's
    history and the audit log. Append-only; needs no lock beyond the caller's."""
    core._log_event(
        booking,
        actor=None,
        from_status=booking.status,
        to_status=booking.status,
        reason=reason,
        meta=meta or {},
    )
    core._audit(booking, actor=None, action=f"booking.{reason}", before={}, after=meta or {})


def extend_hold_for_payment(booking: Booking, *, now: datetime, grace: timedelta) -> bool:
    """A provider transaction now exists for this PENDING_PAYMENT booking: stretch the hold to
    ``now + grace`` so a payment page that is still open does not lose the slot to the sweeper
    seconds before the money arrives. Bounded: never beyond ``created + hold + grace`` (a driver
    cannot keep a slot by re-opening payment pages). Caller holds the locks. True if it moved."""
    if booking.status != BookingStatus.PENDING_PAYMENT or booking.hold_expires_at is None:
        return False
    ceiling = booking.created_at + get_config().hold + grace
    target = min(max(booking.hold_expires_at, now + grace), ceiling)
    if target <= booking.hold_expires_at:
        return False
    before = booking.hold_expires_at
    booking.hold_expires_at = target
    booking.save(update_fields=["hold_expires_at", "updated_at"])
    log_booking_event(
        booking,
        reason="hold_extended",
        meta={"from": before.isoformat(), "to": target.isoformat()},
    )
    return True


def cancel_after_provider_refund(booking: Booking, *, now: datetime) -> Booking:
    """The provider returned the whole payment on its side (Payme CancelTransaction of a
    performed transaction): CONFIRMED -> CANCELLED with the paid amount marked refunded. Caller
    holds the locks and has checked the booking is CONFIRMED."""
    return core._apply_transition(
        booking,
        BookingStatus.CANCELLED,
        actor=None,
        reason="provider_refund",
        audit_action="booking.cancel",
        fields={"cancelled_at": now, "refund_amount": booking.paid_amount},
        meta={"refund_amount": str(booking.paid_amount)},
    )
