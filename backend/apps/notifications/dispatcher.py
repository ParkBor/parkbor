"""``notify()``: the single, idempotent entry point for sending a user a notification.

It only records the fact (``NotificationLog``, UNIQUE per user + event + dedupe key) and queues
the delivery; nothing external happens here, so it is safe to call from hooks and sweeps. The
channel choice, templates and retries live in ``delivery.py`` / ``tasks.py``.
"""

import logging

from django.db import IntegrityError, transaction

from .events import EVENTS
from .models import NotificationLog

logger = logging.getLogger(__name__)

# The only values a template may use. Anything else (plates, phones, names) is dropped here, so
# it can never end up in the log table or in a message.
CONTEXT_KEYS = ("booking_id", "slot", "amount")
DEDUPE_KEY_MAX = 80


def _clean_context(context: dict | None) -> dict[str, str]:
    context = context or {}
    return {key: str(context[key]) for key in CONTEXT_KEYS if context.get(key) is not None}


def enqueue(log_id, countdown: float | None = None) -> bool:
    """Queue the delivery. A broker outage is logged, never raised: the log stays PENDING and
    ``notifications.resend_pending`` queues it again."""
    from .tasks import send_notification

    try:
        send_notification.apply_async(args=[str(log_id)], countdown=countdown)
    except Exception:  # noqa: BLE001 - the booking flow must not fail because of the broker
        logger.exception("could not queue notification %s", log_id)
        return False
    return True


def notify(
    user_id, event: str, context: dict | None = None, *, dedupe_key
) -> NotificationLog | None:
    """Record "tell this user about this fact" and queue the delivery after commit.

    Returns the new log, or None when there is nobody to tell (``user_id`` None: a walk-in) or
    the same fact was already recorded (a repeated hook, a sweep run twice, a retried task).
    """
    if event not in EVENTS:
        raise ValueError(f"unknown notification event: {event!r}")
    if user_id is None:
        return None
    key = str(dedupe_key)[:DEDUPE_KEY_MAX]
    try:
        with transaction.atomic():  # a savepoint: the duplicate must not poison an outer tx
            log = NotificationLog.objects.create(
                user_id=user_id, event=event, dedupe_key=key, context=_clean_context(context)
            )
    except IntegrityError:
        if NotificationLog.objects.filter(user_id=user_id, event=event, dedupe_key=key).exists():
            return None
        raise  # not a duplicate (e.g. the user does not exist): do not hide it
    transaction.on_commit(lambda: enqueue(log.pk))
    return log
