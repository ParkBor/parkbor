"""Errors of the operator gate (check-in, check-out, walk-in; Step 9). Body: ``{detail, code}``.

The ``code`` is what the operator's screen switches on (green / red + reason). 409 = the world
is not in a state that allows the action (nothing was changed); 403 = not allowed for this user.
"""

from apps.core.exceptions import (
    ApiError,
    Conflict,
    DomainPermissionDenied,
    NotFoundError,
    UnprocessableError,
)


class WrongLot(Conflict):
    """Also used when the operator has no access to the booking's lot, so the answer never tells
    a stranger whether a booking exists."""

    default_detail = "This code is not for this parking lot."
    default_code = "wrong_lot"


class QrOutdated(Conflict):
    default_detail = "This QR code was replaced by a newer one. Ask the driver to reopen it."
    default_code = "qr_outdated"


class QrAlreadyUsed(Conflict):
    default_detail = "This QR code has already been used."
    default_code = "already_used"


class BookingNotPaid(Conflict):
    default_detail = "The booking is not paid."
    default_code = "booking_not_paid"


class BookingExpired(Conflict):
    default_detail = "The booking expired unpaid."
    default_code = "booking_expired"


class BookingCancelled(Conflict):
    default_detail = "The booking was cancelled."
    default_code = "booking_cancelled"


class BookingNoShow(Conflict):
    default_detail = "The driver arrived too late: the booking is a no-show."
    default_code = "booking_no_show"


class BookingOver(Conflict):
    default_detail = "The booked period has already ended."
    default_code = "booking_over"


class BookingCompleted(Conflict):
    default_detail = "The booking is already completed."
    default_code = "booking_completed"


class TooEarly(Conflict):
    default_detail = "Too early: the driver may enter shortly before the booked start."
    default_code = "too_early"


class SlotOccupied(Conflict):
    default_detail = "The slot is still occupied."
    default_code = "slot_occupied"


class SlotOutOfService(Conflict):
    default_detail = "The slot is out of service."
    default_code = "slot_out_of_service"


class SlotReservedSoon(Conflict):
    default_detail = "A booking on this slot starts too soon for a walk-in."
    default_code = "slot_reserved_soon"


class NotCheckedIn(Conflict):
    default_detail = "The car has not been checked in."
    default_code = "not_checked_in"


class BookingNotActive(Conflict):
    default_detail = "The booking is not active."
    default_code = "booking_not_active"


class PlateMismatch(Conflict):
    default_detail = "The plate number does not match the booking."
    default_code = "plate_mismatch"


class BookingNotFound(NotFoundError):
    default_detail = "Booking not found."
    default_code = "booking_not_found"


class SelfServiceForbidden(DomainPermissionDenied):
    default_detail = "Staff cannot serve their own bookings."
    default_code = "self_service_forbidden"


class ExitQrRequired(DomainPermissionDenied):
    """An ONLINE booking leaves with its owner's exit QR (a second factor: the plate is public).
    Only an OWNER / ADMIN may override, with a written reason."""

    default_detail = "This booking can only be checked out with the driver's exit QR."
    default_code = "exit_qr_required"


class ReviewRequired(Conflict):
    """The charge was capped / unpriced and is waiting for an administrator's decision."""

    default_detail = "This charge needs an owner's or administrator's review before it is settled."
    default_code = "needs_review"


class PlateRequired(UnprocessableError):
    default_detail = "This parking lot requires the car's plate number at check-in."
    default_code = "plate_required"


class PlateBusy(Conflict):
    """Walk-in refused because the plate is already booked or parked. Deliberately says nothing
    about WHERE (another lot's booking must not leak to the operator)."""

    default_detail = "This vehicle cannot be registered right now."
    default_code = "plate_busy"


class WalkInRateLimited(ApiError):
    status_code = 429
    default_detail = "Too many walk-ins registered in the last hour."
    default_code = "walk_in_rate_limited"


class ScanLocked(ApiError):
    status_code = 429
    default_detail = "Too many invalid scans. Scanning is paused; try again later."
    default_code = "scan_locked"
