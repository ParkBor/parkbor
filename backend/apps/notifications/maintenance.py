"""Housekeeping for notifications: old devices, old log rows, notifications whose queueing was
lost. Every function is idempotent and bounded (batches), safe to run repeatedly."""

import logging
from datetime import datetime, timedelta

from django.conf import settings
from django.utils import timezone

from apps.accounts.models import Device

from .dispatcher import enqueue
from .models import NotificationLog

logger = logging.getLogger(__name__)

DELETE_BATCH = 5000
MAX_BATCHES = 40  # one run removes at most 200 000 rows; the next run continues
RESEND_AFTER = timedelta(minutes=2)


def _delete_in_batches(queryset) -> int:
    total = 0
    for _ in range(MAX_BATCHES):
        ids = list(queryset.values_list("pk", flat=True)[:DELETE_BATCH])
        if not ids:
            break
        total += queryset.model.objects.filter(pk__in=ids).delete()[0]
    return total


def prune_devices(now: datetime | None = None) -> int:
    """Devices not seen for PUSH_TOKEN_MAX_AGE_DAYS (the app re-registers its token on every
    start, so a silent device is an uninstalled app)."""
    cutoff = (now or timezone.now()) - timedelta(days=settings.PUSH_TOKEN_MAX_AGE_DAYS)
    return _delete_in_batches(Device.objects.filter(last_seen__lt=cutoff))


def purge_logs(now: datetime | None = None) -> int:
    cutoff = (now or timezone.now()) - timedelta(days=settings.NOTIFICATION_LOG_RETENTION_DAYS)
    return _delete_in_batches(NotificationLog.objects.filter(created_at__lt=cutoff))


def resend_pending(now: datetime | None = None, limit: int | None = None) -> int:
    """Queue again the PENDING rows nobody is working on (the broker was down when they were
    created, or a worker died between attempts). A row that is merely waiting for its own
    retry is re-queued too; the claim in ``delivery`` makes a second send impossible."""
    now = now or timezone.now()
    limit = limit or settings.NOTIFICATION_BATCH_LIMIT
    stale = NotificationLog.objects.filter(
        status=NotificationLog.Status.PENDING, updated_at__lt=now - RESEND_AFTER
    ).exclude(lease_until__gt=now)
    queued = 0
    for log_id in stale.order_by("updated_at").values_list("pk", flat=True)[:limit]:
        queued += enqueue(log_id)
    return queued
