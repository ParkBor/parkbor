"""API errors of the booking domain. Body shape: ``{"detail": ..., "code": <machine code>}``.

409 = the world changed under the client (retry/refresh); 422 = the request is well-formed but
breaks a booking rule; 400 = malformed request metadata (Idempotency-Key header).
"""

from apps.core.exceptions import (
    ApiError,
    Conflict,
    DomainValidationError,
    ServiceUnavailableError,
    UnprocessableError,
)


class NoSlotAvailable(Conflict):
    default_detail = "No free slot for the chosen period."
    default_code = "no_slot_available"


class BookingConflict(Conflict):
    default_detail = "The booking overlaps another booking on this slot."
    default_code = "booking_conflict"


class IdempotencyConflict(UnprocessableError):
    default_detail = "This Idempotency-Key was already used with a different request."
    default_code = "idempotency_conflict"


class IdempotencyInProgress(Conflict):
    default_detail = "A request with this Idempotency-Key is still being processed."
    default_code = "idempotency_in_progress"


class IdempotencyKeyError(DomainValidationError):
    default_code = "idempotency_key_invalid"


class QrNotAvailable(Conflict):
    default_detail = "A QR code is available only for confirmed or active bookings."
    default_code = "qr_not_available"


class VehicleBusy(Conflict):
    default_detail = "This vehicle already has a booking in this period."
    default_code = "vehicle_busy"


class ExtendUnavailable(Conflict):
    default_detail = "Extending a booking is not available yet."
    default_code = "extend_unavailable"


class BookingCooldown(ApiError):
    status_code = 429
    default_detail = "Too many abandoned bookings. Try again in a few minutes."
    default_code = "booking_cooldown"


class LockTimeout(ServiceUnavailableError):
    default_detail = "The parking lot is busy. Try again in a moment."
    default_code = "lock_timeout"


class SerializationRetry(ServiceUnavailableError):
    """A deadlock (SQLSTATE 40P01) survived the one internal retry: the client should retry."""

    default_detail = "The request collided with another one. Please try again."
    default_code = "serialization_retry"


def rule_violation(code: str, detail: str) -> UnprocessableError:
    """A 422 with a specific machine code (period_too_short, lot_closed, ...)."""
    return UnprocessableError(detail, code)
