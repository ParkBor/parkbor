"""Celery tasks of the notifications app (ARCHITECTURE 16). All idempotent."""

import logging

from celery import shared_task

from . import delivery, maintenance, receipts, reminders

logger = logging.getLogger(__name__)

LIMITS = {"soft_time_limit": 45, "time_limit": 60}


@shared_task(
    name="notifications.send",
    acks_late=True,
    ignore_result=True,
    # Celery's rate_limit is per worker INSTANCE (a whole `celery worker`, not per process).
    # Telegram allows about 30 messages/s for the whole bot, so run ONE worker on the "notify"
    # queue (ARCHITECTURE 17) and keep it below that.
    rate_limit="25/s",
    **LIMITS,
)
def send_notification(log_id: str) -> bool:
    """Deliver one notification; schedule the next attempt itself when a channel asked to wait."""
    result = delivery.deliver(log_id)
    if result.retry_in is not None:
        # Same enqueue helper as notify(): a broker outage leaves the row PENDING and
        # notifications.resend_pending queues it again.
        from .dispatcher import enqueue

        enqueue(log_id, countdown=result.retry_in)
        return False
    return True


@shared_task(name="notifications.send_reminders", ignore_result=True, **LIMITS)
def send_reminders() -> int:
    return reminders.send_reminders()


@shared_task(name="notifications.prune_push_tokens", ignore_result=True, **LIMITS)
def prune_push_tokens() -> int:
    """Daily: devices that have not been seen for 90 days."""
    return maintenance.prune_devices()


@shared_task(name="notifications.purge_notification_log", ignore_result=True, **LIMITS)
def purge_notification_log() -> int:
    """Daily: log rows older than the retention period (180 days)."""
    return maintenance.purge_logs()


@shared_task(name="notifications.resend_pending", ignore_result=True, **LIMITS)
def resend_pending() -> int:
    return maintenance.resend_pending()


@shared_task(name="notifications.check_push_receipts", ignore_result=True, **LIMITS)
def check_push_receipts() -> dict:
    """Read Expo receipts and delete devices reported as DeviceNotRegistered."""
    return receipts.check_receipts()
