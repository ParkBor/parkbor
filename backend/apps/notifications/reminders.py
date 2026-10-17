"""``send_reminders``: "N minutes left" for CONFIRMED / ACTIVE bookings (ARCHITECTURE 3.1(11)).

N is ``NOTIFICATION_REMINDER_MINUTES`` (15); the message text uses the same setting."""

import logging
from datetime import datetime, timedelta

from django.conf import settings
from django.utils import timezone

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus

from . import events as ev
from .dispatcher import notify
from .models import NotificationLog

logger = logging.getLogger(__name__)

REMINDED_STATUSES = (BookingStatus.CONFIRMED, BookingStatus.ACTIVE)
PAGE_SIZE = 200
MAX_SCANNED_FACTOR = 20  # a run looks at most this many times the batch limit of bookings


def _reminded(page: list[tuple]) -> set[str]:
    """Dedupe keys of the page's bookings that already have their reminder. The lookup names the
    user as well as the key, so it can use the UNIQUE index (user, event, dedupe_key) instead of
    scanning every reminder ever sent."""
    return set(
        NotificationLog.objects.filter(
            user_id__in={user_id for _, user_id in page},
            event=ev.REMINDER_15M_LEFT,
            dedupe_key__in=[str(booking_id) for booking_id, _ in page],
        ).values_list("dedupe_key", flat=True)
    )


def _due_pages(now: datetime, limit: int):
    """Bookings ending within the reminder window, soonest first, a page at a time (so already
    reminded ones at the front of the queue can never starve the ones behind them)."""
    horizon = now + timedelta(minutes=settings.NOTIFICATION_REMINDER_MINUTES)
    due = (
        Booking.objects.filter(
            status__in=REMINDED_STATUSES,
            user__isnull=False,
            ends_at__gt=now,
            ends_at__lte=horizon,
        )
        .order_by("ends_at", "id")
        .values_list("pk", "user_id")
    )
    for start in range(0, limit * MAX_SCANNED_FACTOR, PAGE_SIZE):
        page = list(due[start : start + PAGE_SIZE])
        if not page:
            return
        yield page


def send_reminders(now: datetime | None = None, limit: int | None = None) -> int:
    """Queue the reminder for every booking whose end is at most N minutes away (and still in the
    future). Safe to run any number of times: ``notify`` deduplicates per booking, and bookings
    that already have their reminder are filtered out first so a busy minute stays cheap.
    One booking failing never stops the others. Returns the number of reminders queued."""
    now = now or timezone.now()
    limit = limit or settings.NOTIFICATION_BATCH_LIMIT
    queued = failed = 0
    for page in _due_pages(now, limit):
        already = _reminded(page)
        for booking_id, user_id in page:
            if str(booking_id) in already:
                continue
            if queued >= limit:
                return queued
            try:
                log = notify(
                    user_id, ev.REMINDER_15M_LEFT, {"booking_id": booking_id}, dedupe_key=booking_id
                )
            except Exception:  # noqa: BLE001 - isolation: one bad row must not stop the rest
                failed += 1
                logger.exception("reminder for booking %s failed", booking_id)
                continue
            queued += log is not None
    if failed:
        logger.error("send_reminders: %d failed, %d queued", failed, queued)
    return queued
