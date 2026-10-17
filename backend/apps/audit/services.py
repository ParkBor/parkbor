"""Retention of the audit log: the ONLY code that deletes audit rows."""

import logging
from datetime import datetime, timedelta

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from .models import AuditLog, purge_allowed

logger = logging.getLogger(__name__)

PURGE_BATCH = 10_000
MAX_BATCHES_PER_RUN = 50  # a run stays within the task's time limit; the next day continues


def _allow_database_purge() -> None:
    """Tell the PostgreSQL trigger (migration 0002) that THIS transaction is the retention purge."""
    if connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_config('habi.audit_purge', 'on', true)")


def purge(*, now: datetime | None = None, batch: int = PURGE_BATCH) -> int:
    """Delete audit rows older than ``AUDIT_RETENTION_DAYS``, ``batch`` rows per short
    transaction. Idempotent. Returns how many rows were deleted in this run."""
    cutoff = (now or timezone.now()) - timedelta(days=settings.AUDIT_RETENTION_DAYS)
    deleted_total = 0
    for _ in range(MAX_BATCHES_PER_RUN):
        with transaction.atomic():
            _allow_database_purge()
            ids = list(
                AuditLog.objects.filter(created_at__lt=cutoff)
                .order_by("created_at", "id")
                .values_list("pk", flat=True)[:batch]
            )
            if not ids:
                break
            with purge_allowed():
                deleted, _ = AuditLog.objects.filter(pk__in=ids).delete()
        deleted_total += deleted
        if len(ids) < batch:
            break
    if deleted_total:
        logger.info("audit purge: %d rows older than %s deleted", deleted_total, cutoff.date())
    return deleted_total
