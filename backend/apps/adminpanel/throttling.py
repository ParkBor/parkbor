from apps.core.throttling import AuthenticatedUserThrottle


class OperatorAssignThrottle(AuthenticatedUserThrottle):
    """Assign / revoke operators: 20 per minute per user (rate ``operator_assign``). The assign
    call reveals whether a phone number or username has an account, so it is limited."""

    scope = "operator_assign"
