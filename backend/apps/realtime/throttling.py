from apps.core.throttling import AuthenticatedUserThrottle


class WsTicketThrottle(AuthenticatedUserThrottle):
    scope = "ws_ticket"
