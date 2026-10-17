"""Celery tasks of the parking app (ARCHITECTURE 16)."""

from celery import shared_task

from . import services


@shared_task(name="parking.reconcile_free_slots", soft_time_limit=240, time_limit=270)
def reconcile_free_slots() -> int:
    """Every 5 minutes: recount each lot's slots and repair drifted counters. Returns how many
    lots were repaired (0 is the healthy answer)."""
    return services.reconcile_counters().fixed
