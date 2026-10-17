from apps.core.throttling import AuthenticatedUserThrottle


class RoutesThrottle(AuthenticatedUserThrottle):
    """Per-user limit for GET /routes (rate `routes` in DEFAULT_THROTTLE_RATES)."""

    scope = "routes"
