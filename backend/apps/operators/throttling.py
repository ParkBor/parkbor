from apps.core.throttling import AuthenticatedUserThrottle


class OperatorScanThrottle(AuthenticatedUserThrottle):
    """POST checkin / checkout: 60 per minute per user, one budget for both (``operator_scan``)."""

    scope = "operator_scan"


class OperatorReadThrottle(AuthenticatedUserThrottle):
    """GET lots / slot map: 120 per minute per user (``operator_read``); the map is polled."""

    scope = "operator_read"


class OperatorWriteThrottle(AuthenticatedUserThrottle):
    """PATCH slot, POST walk-in: 30 per minute per user (``operator_write``)."""

    scope = "operator_write"


class OperatorInviteAcceptThrottle(AuthenticatedUserThrottle):
    """POST /me/operator-invites/accept: 10 per hour per user (``operator_invite_accept``)."""

    scope = "operator_invite_accept"
