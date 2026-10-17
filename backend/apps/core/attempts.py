"""Failure counters in the Django cache (Redis in production) with a lock-out window.

Used by the scan guard and the invitation-code guard. Properties that matter:

* every key is created WITH a time-to-live (``add`` sets it atomically); the lock-out end is
  stored next to it, and a counter whose end marker is missing counts as OPEN, so a counter
  that somehow lost its TTL (``INCR`` re-creating an expired key) can never lock anyone forever;
* if the cache is down the guard fails OPEN: a gate must keep working; the per-minute throttles
  and the persisted audit remain.
"""

import logging
import time
from dataclasses import dataclass

from django.core.cache import cache

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FailureCounter:
    prefix: str
    limit: int
    window_seconds: int

    def _count_key(self, key) -> str:
        return f"habi:{self.prefix}:n:{key}"

    def _until_key(self, key) -> str:
        return f"habi:{self.prefix}:until:{key}"

    def _marker_key(self, key) -> str:
        return f"habi:{self.prefix}:locked:{key}"

    def seconds_locked(self, key) -> int:
        """Seconds the lock still lasts (0 = open)."""
        try:
            if cache.get(self._count_key(key), 0) < self.limit:
                return 0
            until = cache.get(self._until_key(key))
            if until is None:  # no end marker: never lock on a counter we cannot bound
                cache.delete(self._count_key(key))
                return 0
            remaining = until - time.time()
            return 0 if remaining <= 0 else max(int(remaining), 1)
        except Exception:  # noqa: BLE001 - fail open
            logger.warning(
                "failure counter %s unavailable (cache error); not enforcing", self.prefix
            )
            return 0

    def record(self, key) -> int:
        """Count one failure; returns the new count (0 if the cache is unavailable)."""
        try:
            count = self._increment(key)
            if count == 1:  # belt and braces: whoever created the key sets its end and its TTL
                cache.touch(self._count_key(key), self.window_seconds)
            return count
        except Exception:  # noqa: BLE001
            logger.warning("failure counter %s unavailable (cache error); not counted", self.prefix)
            return 0

    def _increment(self, key) -> int:
        count_key = self._count_key(key)
        if cache.add(count_key, 1, timeout=self.window_seconds):
            cache.set(self._until_key(key), time.time() + self.window_seconds, self.window_seconds)
            return 1
        try:
            return cache.incr(count_key)
        except ValueError:  # expired between add and incr: start a new window
            cache.add(count_key, 1, timeout=self.window_seconds)
            cache.set(self._until_key(key), time.time() + self.window_seconds, self.window_seconds)
            return 1

    def first_time_locked(self, key) -> bool:
        """True exactly once per lock-out window (to audit the moment of locking once)."""
        try:
            return bool(cache.add(self._marker_key(key), 1, timeout=self.window_seconds))
        except Exception:  # noqa: BLE001
            return False
