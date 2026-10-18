from apps.core.throttling import AuthenticatedUserThrottle


class OperatorAssignThrottle(AuthenticatedUserThrottle):
    """Assign / revoke operators: 20 per minute per user (rate ``operator_assign``). The assign
    call reveals whether a phone number or username has an account, so it is limited."""

    scope = "operator_assign"


class AdminReadThrottle(AuthenticatedUserThrottle):
    """GET /admin/{users,bookings,payments,refunds,reviews,settings,audit-logs,stats/*}: 120/min."""

    scope = "admin_read"


class AdminWriteThrottle(AuthenticatedUserThrottle):
    """Admin mutations (user changes, cancel, refund resolve, moderation, settings): 30/min."""

    scope = "admin_write"
