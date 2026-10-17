"""``send_reminders``: "15 minutes left" for CONFIRMED / ACTIVE bookings (ARCHITECTURE 3.1(11))."""

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


def send_reminders(now: datetime | None = None, limit: int | None = None) -> int:
    """Queue the reminder for every booking whose end is at most N minutes away (and still in the
    future). Safe to run any number of times: ``notify`` deduplicates per booking, and bookings
    that already have their reminder are filtered out first so a busy minute stays cheap.
    One booking failing never stops the others. Returns the number of reminders queued."""
    now = now or timezone.now()
    limit = limit or settings.NOTIFICATION_BATCH_LIMIT
    horizon = now + timedelta(minutes=settings.NOTIFICATION_REMINDER_MINUTES)
    due = list(
        Booking.objects.filter(
            status__in=REMINDED_STATUSES,
            user__isnull=False,
            ends_at__gt=now,
            ends_at__lte=horizon,
        )
        .order_by("ends_at", "id")
        .values_list("pk", "user_id")[: limit * 2]
    )
    already = set(
        NotificationLog.objects.filter(
            event=ev.REMINDER_15M_LEFT, dedupe_key__in=[str(pk) for pk, _ in due]
        ).values_list("dedupe_key", flat=True)
    )
    queued = failed = 0
    for booking_id, user_id in due:
        if str(booking_id) in already or queued >= limit:
            continue
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
