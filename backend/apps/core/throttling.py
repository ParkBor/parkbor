import time

from rest_framework.throttling import UserRateThrottle


class AuthenticatedUserThrottle(UserRateThrottle):
    """Per-user limit (scope "user") for authenticated endpoints."""

    # Resolve time.time at call time (a plain builtin attribute gets rewritten by time freezing).
    timer = staticmethod(lambda: time.time())
