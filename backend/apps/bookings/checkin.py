"""Operator check-in: a scanned QR turns a CONFIRMED booking into ACTIVE (ARCHITECTURE 6.3, 10.8).

ONE transaction, lot lock first. Order (10.8, Step 9):

    verify_token (signature, window, purpose)        -- no database
    lot of the booking, read from the BOOKING (never from the token), operator access
    lock lot -> lock booking -> access again under the lock
    claims lot == booking lot  (else ``wrong_lot``); not the operator's own booking
    plate (if the operator typed one) must match the booking
    booking already inside: ``already_checked_in`` ONLY for the very entry code that was spent
        at check-in (its nonce hash is kept), any other entry code is ``qr_outdated``
    status / time rules, then ``claims_match_booking`` (nonce)   -- all before anything is spent
    physical slot check
    consume_nonce  (DB column, atomic; Redis is only written after commit)
    slot OCCUPIED, then ONE update: CONFIRMED -> ACTIVE, ``checked_in_at``, a fresh nonce for the
    exit QR, and the hash of the spent entry nonce

Anything that fails after ``consume_nonce`` rolls the whole transaction back, so the nonce is
unspent again. A repeat scan of the same entry code (a screenshot, a double tap) answers
``already_checked_in`` but is NOT an admission: the operator screen shows it amber
(``allowed: false``), the car is already inside and nothing is changed or spent.
"""

import hmac
import logging
from dataclasses import dataclass
from datetime import datetime

from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.utils import timezone

from apps.core.exceptions import ApiError
from apps.parking.models import SlotStatus
from apps.vehicles.plate import InvalidPlate, normalize_plate

from . import operations, qr, services
from .conf import BookingConfig, get_config
from .gate_errors import (
    BookingCancelled,
    BookingCompleted,
    BookingExpired,
    BookingNoShow,
    BookingNotPaid,
    BookingOver,
    PlateMismatch,
    PlateRequired,
    QrAlreadyUsed,
    QrOutdated,
    SelfServiceForbidden,
    SlotOccupied,
    SlotOutOfService,
    TooEarly,
    WrongLot,
)
from .models import Booking
from .state import BookingStatus

logger = logging.getLogger(__name__)

RESULT_CHECKED_IN = "checked_in"
RESULT_ALREADY = "already_checked_in"

_REFUSED = {
    BookingStatus.PENDING_PAYMENT: BookingNotPaid,
    BookingStatus.EXPIRED: BookingExpired,
    BookingStatus.CANCELLED: BookingCancelled,
    BookingStatus.NO_SHOW: BookingNoShow,
    BookingStatus.COMPLETED: BookingCompleted,
}
_INSIDE = (BookingStatus.ACTIVE, BookingStatus.OVERSTAY)
_SECRET_FIELDS = frozenset({"qr_nonce", "qr_nonce_used_at", "checkin_nonce_hash"})


@dataclass(frozen=True)
class CheckInResult:
    booking: Booking
    code: str  # "checked_in" | "already_checked_in"

    @property
    def already_checked_in(self) -> bool:
        return self.code == RESULT_ALREADY

    @property
    def allowed(self) -> bool:
        """Green only for a real admission; a repeat scan is amber."""
        return self.code == RESULT_CHECKED_IN


@dataclass(frozen=True)
class _Scan:
    """What one check-in attempt carries through its steps."""

    operator: object
    claims: qr.QrClaims
    lot_id: object
    plate: str | None
    now: datetime


@dataclass(frozen=True)
class CheckInRequest:
    """What the operator's screen sent: the scanned code and, optionally, the lot and the plate."""

    operator: object
    token: object
    expected_lot_id: object = None
    plate_number: str | None = None


def check_in(
    *,
    operator,
    token,
    expected_lot_id=None,
    plate_number: str | None = None,
    now: datetime | None = None,
) -> CheckInResult:
    """Check a driver in by their scanned entry QR.

    ``expected_lot_id``: the lot the operator's screen is working in; a valid code of any other
    lot is refused as ``wrong_lot``. ``plate_number`` (optional): the plate read from the car,
    compared with the booking (409 ``plate_mismatch``). Every attempt, accepted or refused, leaves
    one audit line (never the token).
    """
    now = now or timezone.now()
    trace = operations.ScanTrace()
    try:
        request = CheckInRequest(operator, token, expected_lot_id, plate_number)
        result = _check_in(request, now, trace)
    except ApiError as exc:
        operations.audit_scan("operator.checkin", operator, operations.error_code(exc), trace)
        raise
    operations.audit_scan("operator.checkin", operator, result.code, trace)
    return result


def _plate_or_none(raw: str | None) -> str | None:
    if raw is None:
        return None
    try:
        return normalize_plate(raw)
    except InvalidPlate:
        return ""  # never equals a recorded plate


def _check_in(request: CheckInRequest, now, trace) -> CheckInResult:
    operator = request.operator
    claims = qr.verify_token(request.token, expected_purpose=qr.PURPOSE_ENTRY, now=now)
    lot_id, allowed = operations.locate(operator, claims.booking_id)
    if lot_id is None:
        raise qr.QrInvalid
    if allowed:  # ids are traced only for lots the operator may see
        trace.booking_id, trace.lot_id = claims.booking_id, lot_id
    if not allowed or (request.expected_lot_id is not None and lot_id != request.expected_lot_id):
        raise WrongLot  # no access = the same answer as a code of a foreign lot
    scan = _Scan(operator, claims, lot_id, _plate_or_none(request.plate_number), now)
    return _check_in_tx(scan)


@services.retrying
@transaction.atomic
def _check_in_tx(scan: _Scan) -> CheckInResult:
    cfg = get_config()
    services.set_local_timeouts(cfg.lock_timeout_seconds)
    lot = services.lock_lot(scan.lot_id)  # 1. the lot, always first
    try:
        booking = services.lock_booking_row(scan.claims.booking_id)  # 2. the booking
    except ObjectDoesNotExist as exc:
        raise qr.QrInvalid from exc
    if not operations.still_operable(scan.operator, lot) or scan.claims.lot_id != lot.pk:
        raise WrongLot
    if booking.user_id == scan.operator.pk:
        raise SelfServiceForbidden
    if scan.plate is None and lot.require_plate_on_checkin:
        raise PlateRequired  # the lot wants the plate read from the car every time
    if scan.plate is not None and scan.plate != booking.vehicle_plate:
        raise PlateMismatch  # before any status is revealed
    if booking.status in _INSIDE:
        return _repeat_scan(booking, scan.claims)
    _check_status_and_time(booking, scan.now, cfg)
    if not qr.claims_match_booking(scan.claims, booking):
        raise QrOutdated
    slot = services.lock_slot_wait(booking.slot_id)  # 3. the slot
    _check_slot(slot)
    if not qr.consume_nonce(scan.claims, now=scan.now):
        raise QrAlreadyUsed
    operations.set_slot_status_locked(lot, slot, SlotStatus.OCCUPIED)
    services.apply_transition(
        booking,
        BookingStatus.ACTIVE,
        actor=scan.operator,
        reason="checked_in",
        audit_action="booking.check_in",
        fields={
            "checked_in_at": scan.now,
            "qr_nonce": qr.new_nonce(),  # the exit code starts from a fresh, unspent nonce
            "qr_nonce_used_at": None,
            "checkin_nonce_hash": qr.nonce_hash(scan.claims.nonce),
        },
        meta={"slot": str(slot.pk)},
        redact=_SECRET_FIELDS,
    )
    return CheckInResult(booking=booking, code=RESULT_CHECKED_IN)


def _repeat_scan(booking: Booking, claims: qr.QrClaims) -> CheckInResult:
    """The car is already inside. Only the very code that admitted it is recognised (and shown
    amber); a stale or other entry code gets no hint that the booking is inside."""
    spent = booking.checkin_nonce_hash
    if spent and hmac.compare_digest(qr.nonce_hash(claims.nonce), spent):
        return CheckInResult(booking=booking, code=RESULT_ALREADY)
    raise QrOutdated


def _check_status_and_time(booking: Booking, now: datetime, cfg: BookingConfig) -> None:
    refusal = _REFUSED.get(booking.status)
    if refusal is not None:
        raise refusal
    if now >= booking.ends_at:
        raise BookingOver
    if now > booking.starts_at + cfg.no_show_grace:  # the sweep (mark_no_shows) changes the status
        raise BookingNoShow
    if now < booking.starts_at - cfg.checkin_early:
        raise TooEarly


def _check_slot(slot) -> None:
    if slot.status == SlotStatus.OUT_OF_SERVICE:
        raise SlotOutOfService
    if slot.status == SlotStatus.OCCUPIED:
        # TODO(reassign): offer another free slot of the same type instead of refusing (10.7).
        raise SlotOccupied
