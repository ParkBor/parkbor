"""Celery tasks of the audit log (ARCHITECTURE 16)."""

from celery import shared_task

from . import services

# Up to 50 batches of 10 000 rows: generous, but a stuck worker is still stopped.
LIMITS = {"soft_time_limit": 240, "time_limit": 270}


@shared_task(name="audit.purge_audit_log", **LIMITS)
def purge_audit_log() -> int:
    """Daily: delete audit rows past ``AUDIT_RETENTION_DAYS`` (default 365), in batches."""
    return services.purge()
