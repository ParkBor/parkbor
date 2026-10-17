"""The checkout link of a booking (``Booking.payment_url`` in the API, ARCHITECTURE 9.5)."""

import logging
from datetime import datetime

from django.utils import timezone

from apps.bookings.state import BookingStatus

from . import conf
from .providers.registry import get_provider

logger = logging.getLogger(__name__)


def payment_url_for(booking, now: datetime | None = None) -> str | None:
    """A provider checkout URL, or None when the booking cannot be paid right now: not
    PENDING_PAYMENT, hold over, or the chosen provider is not configured. The URL holds only
    public data (booking id, amount, merchant / service id): never a key or a signature."""
    now = now or timezone.now()
    if booking.status != BookingStatus.PENDING_PAYMENT:
        return None
    if booking.hold_expires_at is None or booking.hold_expires_at <= now:
        return None
    code = booking.payment_provider or conf.get_config().default_provider
    try:
        provider = get_provider(code)
    except KeyError:
        logger.error("booking %s has an unknown payment provider", booking.pk)
        return None
    if not provider.is_configured():
        logger.error("payment provider %s is not configured: no payment_url", code)
        return None
    try:
        return provider.build_payment_url(booking)
    except ValueError:  # a zero / sub-tiyin amount has no checkout link; never a 500 on read
        logger.error("booking %s: no checkout link for its amount", booking.pk)
        return None


def ensure_available(provider_code: str | None) -> None:
    """422 ``payment_provider_unavailable`` if the provider the booking would use (the chosen one,
    or the default) has no credentials: refuse up front instead of holding a slot for a payment
    nobody can make."""
    from apps.bookings.errors import rule_violation

    code = provider_code or conf.get_config().default_provider
    if not get_provider(code).is_configured():
        raise rule_violation(
            "payment_provider_unavailable", "This payment method is not available right now."
        )


REFUND_STATUS_ORDER = ("failed", "manual", "pending", "done")  # the worst one wins
_REFUND_STATUS_NAMES = {
    "FAILED": "failed",
    "MANUAL": "manual",
    "PENDING": "pending",
    "SENT": "pending",
    "DONE": "done",
}


def refund_status_for(booking) -> str:
    """What is happening to ``booking.refund_amount``: none | pending | done | manual | failed.
    ``manual`` = a person must return the money in the provider's cabinet; ``failed`` = the
    automatic attempt gave up. Uses the prefetched ``refunds`` when the caller loaded them."""
    names = {_REFUND_STATUS_NAMES[refund.status] for refund in booking.refunds.all()}
    for name in REFUND_STATUS_ORDER:
        if name in names:
            return name
    return "none"
