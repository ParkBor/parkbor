"""Celery tasks (ARCHITECTURE 16). All idempotent; they delegate to services.py."""

import logging

from celery import shared_task

from . import reassign, services

logger = logging.getLogger(__name__)

# A sweep handles at most BOOKING_TASK_BATCH_LIMIT bookings, one short transaction each; these
# limits stop a stuck worker well before the next minute's run piles up behind it.
LIMITS = {"soft_time_limit": 45, "time_limit": 60}


@shared_task(name="bookings.expire_hold", **LIMITS)
def expire_hold(booking_id: str) -> bool:
    """Scheduled at hold end: PENDING_PAYMENT -> EXPIRED if still unpaid."""
    return services.expire_hold(booking_id)


@shared_task(name="bookings.expire_overdue_holds", **LIMITS)
def expire_overdue_holds() -> int:
    """Safety net for lost expire_hold tasks."""
    return services.expire_overdue_holds()


@shared_task(name="bookings.mark_no_shows", **LIMITS)
def mark_no_shows() -> int:
    return services.mark_no_shows()


@shared_task(name="bookings.detect_overstays", **LIMITS)
def detect_overstays() -> int:
    """ACTIVE past its end -> OVERSTAY, then move the bookings waiting behind those cars."""
    detected = services.detect_overstays()
    try:
        reassign.resolve_overstay_conflicts()
    except Exception:  # noqa: BLE001 - the detection above is committed; retried next minute
        logger.exception("resolve_overstay_conflicts failed")
    return detected
