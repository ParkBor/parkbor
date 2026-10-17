from apps.core.throttling import AuthenticatedUserThrottle


class NearbyThrottle(AuthenticatedUserThrottle):
    """Per-user limit for /parkings/nearby (rate `nearby` in DEFAULT_THROTTLE_RATES)."""

    scope = "nearby"
