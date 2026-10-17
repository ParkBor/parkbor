from apps.core.throttling import AuthenticatedUserThrottle


class BookingCreateThrottle(AuthenticatedUserThrottle):
    """POST /bookings: 10 per minute per user (rate ``booking_create``)."""

    scope = "booking_create"


class BookingMutateThrottle(AuthenticatedUserThrottle):
    """POST cancel / extend: 20 per minute per user (rate ``booking_mutate``)."""

    scope = "booking_mutate"


class BookingQrThrottle(AuthenticatedUserThrottle):
    """GET qr: 30 per minute per user (rate ``booking_qr``): tokens are minted on demand."""

    scope = "booking_qr"


class BookingQuoteThrottle(AuthenticatedUserThrottle):
    """GET availability / price: the booking screen re-queries while the user picks times."""

    scope = "booking_quote"
