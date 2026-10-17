"""Celery discovers tasks in ``tasks.py``: the realtime task itself lives next to its publisher."""

from .publishers import flush_availability

__all__ = ["flush_availability"]
