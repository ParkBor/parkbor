from apps.core.throttling import AuthenticatedUserThrottle


class AccountDeleteThrottle(AuthenticatedUserThrottle):
    """DELETE /me: 5 per hour per user (rate ``account_delete``)."""

    scope = "account_delete"
