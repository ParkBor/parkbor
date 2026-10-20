from apps.core.throttling import AuthenticatedUserThrottle


class NearbyThrottle(AuthenticatedUserThrottle):
    """Per-user limit for /parkings/nearby (rate `nearby` in DEFAULT_THROTTLE_RATES)."""

    scope = "nearby"


class ParkingDetailThrottle(AuthenticatedUserThrottle):
    """GET /parkings/{id}: 120 per minute per user (rate ``parking_detail``)."""

    scope = "parking_detail"
