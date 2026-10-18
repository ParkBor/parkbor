from apps.core.throttling import AuthenticatedUserThrottle


class ReviewWriteThrottle(AuthenticatedUserThrottle):
    """POST /parkings/{id}/reviews: 10 per hour per user (rate ``review_write``)."""

    scope = "review_write"


class ReviewReadThrottle(AuthenticatedUserThrottle):
    """GET /parkings/{id}/reviews: 120 per minute per user (rate ``review_read``)."""

    scope = "review_read"
