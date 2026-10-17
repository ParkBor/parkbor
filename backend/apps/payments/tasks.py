"""Celery tasks (ARCHITECTURE 16). Idempotent; the work lives in refunds.py / reconcile.py."""

import logging

from celery import shared_task

from . import conf, events, reconcile, refunds

logger = logging.getLogger(__name__)

# A refund task makes one provider call (HTTP timeout 10 s); the sweep makes many short
# transactions. These limits stop a stuck worker well before the next run piles up behind it.
LIMITS = {"soft_time_limit": 45, "time_limit": 60}


@shared_task(bind=True, name="payments.send_refund", acks_late=True, **LIMITS)
def send_refund(self, refund_id: str) -> str:
    """Deliver one refund to its provider; retries with exponential backoff (30 s .. 30 min),
    bounded by ``PAYMENTS_REFUND_MAX_ATTEMPTS``. Delivery is AT-LEAST-ONCE: after a lost answer or
    a crashed worker the provider may be called again (see refunds.py for what makes that safe)."""
    outcome = refunds.process_refund(refund_id)
    if outcome.retry_in is not None:
        raise self.retry(
            countdown=outcome.retry_in, max_retries=conf.get_config().refund_max_attempts + 1
        )
    return outcome.refund.status if outcome.refund else "NOT_FOUND"


@shared_task(name="payments.retry_failed_webhooks", **LIMITS)
def retry_failed_webhooks() -> dict[str, int]:
    """Every 5 minutes (ARCHITECTURE 16): payments and refunds that never reached an end."""
    return reconcile.run()


@shared_task(name="payments.purge_webhook_events", **LIMITS)
def purge_webhook_events() -> int:
    """Daily: delete WebhookEvent rows past the retention period (default 90 days)."""
    return events.purge()
