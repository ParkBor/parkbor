"""Token bucket for one WebSocket connection (messages per second, with a burst of one second)."""

import time
from collections.abc import Callable


class TokenBucket:
    def __init__(self, rate_per_second: float, clock: Callable[[], float] = time.monotonic):
        self.rate = float(rate_per_second)
        self.capacity = float(rate_per_second)
        self._clock = clock
        self._tokens = self.capacity
        self._last = clock()

    def allow(self) -> bool:
        now = self._clock()
        self._tokens = min(self.capacity, self._tokens + (now - self._last) * self.rate)
        self._last = now
        if self._tokens < 1:
            return False
        self._tokens -= 1
        return True
