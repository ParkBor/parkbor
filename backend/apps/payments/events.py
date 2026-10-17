"""Audit trail of provider callbacks (``WebhookEvent``). Only safe facts are stored: provider,
method, the provider's transaction id, the order id, the protocol result code, the caller's
address. Never the Authorization header, a signature, or the body."""

import logging
from datetime import datetime

from django.utils import timezone

from . import conf
from .models import WebhookEvent
from .providers.base import WebhookResult

logger = logging.getLogger(__name__)


def record(
    provider: str, result: WebhookResult, *, remote_ip: str | None, duration_ms: int
) -> None:
    """Best effort: the answer to the provider must not depend on the audit row. Callers that
    did not prove they are the provider (bad Basic auth / signature) are only LOGGED: anyone on
    the internet could otherwise fill the table."""
    if not result.authenticated:
        logger.warning("%s webhook rejected unauthenticated (%s)", provider, result.result_code)
        return
    try:
        WebhookEvent.objects.create(
            provider=provider,
            method=result.method[:32],
            external_id=result.external_id[:64],
            booking_id=result.booking_id,
            result_code=result.result_code,
            remote_ip=remote_ip,
            duration_ms=max(duration_ms, 0),
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("could not record a %s webhook event: %s", provider, type(exc).__name__)


PURGE_BATCH = 10_000
MAX_PURGE_BATCHES = 50  # per run; the next daily run continues


def purge(now: datetime | None = None) -> int:
    """Delete events older than ``PAYMENTS_EVENT_RETENTION_DAYS`` in batches (a single huge DELETE
    would hold locks and bloat WAL). Returns how many rows were removed."""
    cutoff = (now or timezone.now()) - conf.get_config().event_retention
    removed = 0
    for _batch in range(MAX_PURGE_BATCHES):
        ids = list(
            WebhookEvent.objects.filter(created_at__lt=cutoff).values_list("pk", flat=True)[
                :PURGE_BATCH
            ]
        )
        if not ids:
            break
        removed += WebhookEvent.objects.filter(pk__in=ids).delete()[0]
    return removed
