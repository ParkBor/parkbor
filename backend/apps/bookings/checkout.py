"""Operator check-out: ACTIVE / OVERSTAY -> COMPLETED, the slot freed (ARCHITECTURE 6.2, 6.3, 10.8).

Two ways to identify the booking, both lot-first like check-in:

* **exit QR** (``qr_token``): the driver's exit code (purpose ``exit``, a fresh nonce created at
  check-in). verify -> claims -> status -> ``consume_nonce`` -> transition in ONE transaction. This
  is the ONLY way out for an ONLINE booking: a plate number is public, so it is not a second
  factor, and a guessed booking id plus a plate must not be able to end someone's stay;
* **by hand** (``booking_id`` + ``plate_number``): for a WALK-IN (no account, no QR). For an ONLINE
  booking (phone dead or lost) only an OWNER / ADMIN may, with ``override=true`` and a written
  ``note``, which goes into the booking history and the audit log.

Leaving is allowed while the lot is suspended or back in review (nobody may be trapped inside).

Money (no online payment at the gate, decision of Step 9): time past the booking end is priced
(``overstay.py``) into ``overstay_amount``; ``collect=true`` says the operator took the cash
(``collected``), otherwise it stays ``due`` for the admin view (Step 11). The usual flow is two
calls: check out (amount shown on the screen), then repeat with ``collect=true`` once the cash is
in; the repeat is harmless and only settles. A walk-in is priced for the whole stay into
``amount`` (``paid_amount`` follows when collected). ``amount`` / ``paid_amount`` of an online
booking are never touched, so refund maths stays as it was. A charge that hit a limit or had no
tariff is recorded in the booking history (``overstay_needs_review`` / ``overstay_no_tariff``).

Repeating a check-out of a COMPLETED booking is a 200 ``already_completed`` and changes nothing
(except settling a due charge when ``collect=true``); it is answered only to a code that passes
the same signature, lot and nonce checks as the first one.
"""

import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.core.exceptions import ApiError
from apps.parking.models import ParkingLot, SlotStatus
from apps.vehicles.plate import InvalidPlate, normalize_plate

from . import operations, overstay, qr, services
from .conf import BookingConfig, get_config
from .gate_errors import (
    BookingNotActive,
    BookingNotFound,
    ExitQrRequired,
    NotCheckedIn,
    PlateMismatch,
    QrAlreadyUsed,
    QrOutdated,
    ReviewRequired,
    SelfServiceForbidden,
    WrongLot,
)
from .models import Booking
from .state import BookingKind, BookingStatus, OverstayStatus

logger = logging.getLogger(__name__)

RESULT_COMPLETED = "completed"
RESULT_ALREADY = "already_completed"
ZERO = Decimal("0.00")
_INSIDE = (BookingStatus.ACTIVE, BookingStatus.OVERSTAY)
_SECONDS_PER_MINUTE = 60
OVERRIDE_ROLES = (User.Role.OWNER, User.Role.ADMIN)


@dataclass(frozen=True)
class CheckOutRequest:
    """What the operator asked for: an exit QR or (booking id + plate)."""

    token: str | None = None
    booking_id: object = None
    plate_number: str | None = None
    collect: bool = False
    expected_lot_id: object = None
    override: bool = False
    note: str = ""


@dataclass(frozen=True)
class CheckOutResult:
    booking: Booking
    code: str  # "completed" | "already_completed"
    actual_minutes: int

    @property
    def to_collect(self) -> Decimal:
        """Cash the operator must still take at the gate."""
        return amount_to_collect(self.booking)


@dataclass(frozen=True)
class _Exit:
    """One check-out attempt, as the transaction sees it."""

    operator: object
    request: CheckOutRequest
    claims: qr.QrClaims | None
    booking_id: object
    lot_id: object
    plate: str | None
    now: datetime


def amount_to_collect(booking: Booking) -> Decimal:
    if booking.overstay_status == OverstayStatus.DUE:
        return booking.overstay_amount
    if booking.kind == BookingKind.WALK_IN and booking.paid_amount < booking.amount:
        return booking.amount - booking.paid_amount
    return ZERO


def check_out(
    *,
    operator,
    now: datetime | None = None,
    request: CheckOutRequest | None = None,
    **fields,
) -> CheckOutResult:
    """Check a car out by exit QR or by hand. ``request`` (or its fields as keywords). Every
    attempt leaves one audit line (never the token)."""
    request = request or CheckOutRequest(**fields)
    if (request.token is None) == (request.booking_id is None):
        raise ValueError("give exactly one of token / booking_id")
    now = now or timezone.now()
    trace = operations.ScanTrace()
    try:
        result = _check_out(operator, request, now, trace)
    except ApiError as exc:
        operations.audit_scan("operator.checkout", operator, operations.error_code(exc), trace)
        raise
    extra = {"collect": request.collect, "overstay_status": result.booking.overstay_status}
    if request.override and result.code == RESULT_COMPLETED:
        extra |= {"override": True, "override_note": request.note}
    operations.audit_scan("operator.checkout", operator, result.code, trace, extra=extra)
    return result


def _check_out(operator, request: CheckOutRequest, now, trace) -> CheckOutResult:
    claims = None
    booking_id = request.booking_id
    if request.token is not None:
        claims = qr.verify_token(request.token, expected_purpose=qr.PURPOSE_EXIT, now=now)
        booking_id = claims.booking_id
    refused = WrongLot if claims else BookingNotFound  # a stranger learns nothing either way
    lot_id, allowed = operations.locate(operator, booking_id, active_only=False)
    if lot_id is None:
        raise qr.QrInvalid if claims else BookingNotFound
    if not allowed:
        raise refused
    trace.booking_id, trace.lot_id = booking_id, lot_id  # only for lots the operator may see
    if request.expected_lot_id is not None and lot_id != request.expected_lot_id:
        raise WrongLot
    plate = None if request.plate_number is None else _plate_or_blank(request.plate_number)
    return _check_out_tx(_Exit(operator, request, claims, booking_id, lot_id, plate, now))


def _plate_or_blank(raw: str | None) -> str:
    try:
        return normalize_plate(raw or "")
    except InvalidPlate:
        return ""  # never equals a recorded plate


@services.retrying
@transaction.atomic
def _check_out_tx(exit_: _Exit) -> CheckOutResult:
    cfg = get_config()
    services.set_local_timeouts(cfg.lock_timeout_seconds)
    lot = services.lock_lot(exit_.lot_id)  # 1. the lot, always first
    try:
        booking = services.lock_booking_row(exit_.booking_id)  # 2. the booking
    except ObjectDoesNotExist as exc:
        raise (qr.QrInvalid if exit_.claims else BookingNotFound) from exc
    _authorize(exit_, lot, booking)
    if booking.status == BookingStatus.COMPLETED:
        return _repeat(booking, exit_)
    _require_inside(booking)
    if exit_.claims is not None:
        _spend_exit_code(exit_.claims, booking, exit_.now)
    return _complete(booking, lot, exit_, cfg)


def _authorize(exit_: _Exit, lot: ParkingLot, booking: Booking) -> None:
    claims = exit_.claims
    if not operations.still_operable(exit_.operator, lot, active_only=False):
        raise WrongLot if claims else BookingNotFound
    if claims is not None and claims.lot_id != lot.pk:
        raise WrongLot
    # a typed plate is checked on both paths (the id path cannot do without it), before any
    # status or kind is revealed
    if claims is None and exit_.plate is None:
        raise PlateMismatch
    if exit_.plate is not None and exit_.plate != booking.vehicle_plate:
        raise PlateMismatch
    if claims is None and booking.kind == BookingKind.ONLINE and not _may_override(exit_):
        raise ExitQrRequired
    if booking.user_id == exit_.operator.pk:
        raise SelfServiceForbidden


def _may_override(exit_: _Exit) -> bool:
    request = exit_.request
    return bool(request.override and request.note.strip() and exit_.operator.role in OVERRIDE_ROLES)


def _spend_exit_code(claims: qr.QrClaims, booking: Booking, now: datetime) -> None:
    if not qr.claims_match_booking(claims, booking):
        raise QrOutdated
    if not qr.consume_nonce(claims, now=now):
        raise QrAlreadyUsed


def _require_inside(booking: Booking) -> None:
    if booking.status in _INSIDE:
        return
    raise NotCheckedIn if booking.status == BookingStatus.CONFIRMED else BookingNotActive


def _complete(
    booking: Booking, lot: ParkingLot, exit_: _Exit, cfg: BookingConfig
) -> CheckOutResult:
    operator, now = exit_.operator, exit_.now
    slot = services.lock_slot_wait(booking.slot_id)  # 3. the slot
    charge = _charge(booking, lot.pk, slot, now, cfg)
    fields = _charge_fields(booking, charge, exit_.request.collect)
    actual = _actual_minutes(booking, now)
    meta = {
        "slot": str(slot.pk),
        "actual_minutes": actual,
        "overstay_minutes": charge.minutes,
        "overstay_amount": str(charge.amount),
        "collected": bool(exit_.request.collect),
    }
    if exit_.request.override:
        meta["override_note"] = exit_.request.note
    services.apply_transition(
        booking,
        BookingStatus.COMPLETED,
        actor=operator,
        reason="checked_out",
        audit_action="booking.check_out",
        fields={"checked_out_at": now, **fields},
        meta=meta,
    )
    _flag_charge(booking, charge, operator)
    Booking.objects.filter(pk=booking.pk, qr_nonce_used_at__isnull=True).update(
        qr_nonce_used_at=now  # a manual check-out spends the nonce too: no code works any more
    )
    free = (
        SlotStatus.OUT_OF_SERVICE if slot.status == SlotStatus.OUT_OF_SERVICE else SlotStatus.FREE
    )
    operations.set_slot_status_locked(lot, slot, free)  # an out-of-service mark is kept
    return CheckOutResult(booking=booking, code=RESULT_COMPLETED, actual_minutes=actual)


def _charge(booking, lot_id, slot, now, cfg) -> overstay.Charge:
    if booking.kind == BookingKind.WALK_IN:
        return overstay.price_walk_in(booking, lot_id, slot, now, cfg)
    return overstay.price_overstay(booking, lot_id, slot, now, cfg)


def _charge_fields(booking: Booking, charge: overstay.Charge, collect: bool) -> dict:
    """Model fields that record what is owed at the gate (see the module docstring). A capped
    charge is never marked collected on the operator's word alone: it stays ``due`` for review."""
    if booking.kind == BookingKind.WALK_IN:
        paid = charge.amount if collect and not charge.needs_review else ZERO
        return {
            "overstay_minutes": 0,
            "overstay_amount": ZERO,
            "overstay_status": OverstayStatus.NONE,
            "overstay_needs_review": charge.needs_review,
            "amount": charge.amount,
            "paid_amount": paid,
        }
    if charge.amount <= 0:
        status = OverstayStatus.NONE
    elif collect and not charge.needs_review:
        status = OverstayStatus.COLLECTED
    else:
        status = OverstayStatus.DUE
    return {
        "overstay_minutes": charge.minutes,
        "overstay_amount": charge.amount,
        "overstay_status": status,
        "overstay_needs_review": charge.needs_review,
    }


def _flag_charge(booking: Booking, charge: overstay.Charge, operator) -> None:
    """History lines (and audit) for charges nobody should miss."""
    for reason, applies in (
        ("overstay_no_tariff", charge.no_tariff),
        ("overstay_bad_terms", charge.bad_terms),
        ("overstay_needs_review", charge.capped),
    ):
        if not applies:
            continue
        meta = {"minutes": charge.minutes, "amount": str(charge.amount)}
        services.log_event(
            booking,
            actor=operator,
            from_status=booking.status,
            to_status=booking.status,
            reason=reason,
            meta=meta,
        )
        services.audit_booking(
            booking, actor=operator, action=f"booking.{reason}", before={}, after=meta
        )


def _actual_minutes(booking: Booking, end: datetime) -> int:
    start = booking.checked_in_at or booking.starts_at
    return max(int((end - start).total_seconds() // _SECONDS_PER_MINUTE), 0)


def _repeat(booking: Booking, exit_: _Exit) -> CheckOutResult:
    """Second check-out of a completed booking: harmless. The exit code must still be the one
    of this booking (nonce) like for the first time; ``collect`` settles a due charge."""
    if exit_.claims is not None and not qr.claims_match_booking(exit_.claims, booking):
        raise QrOutdated
    if exit_.request.collect and amount_to_collect(booking) > 0:
        if booking.overstay_needs_review and not _may_override(exit_):
            raise ReviewRequired  # a capped / unpriced charge is settled by an owner or admin only
        _settle(booking, exit_.operator, exit_.request.note if exit_.request.override else "")
    return CheckOutResult(
        booking=booking,
        code=RESULT_ALREADY,
        actual_minutes=_actual_minutes(booking, booking.checked_out_at or exit_.now),
    )


def _settle(booking: Booking, operator, note: str) -> None:
    due = amount_to_collect(booking)
    if booking.kind == BookingKind.WALK_IN:
        booking.paid_amount = booking.amount
        fields = ["paid_amount", "overstay_needs_review", "updated_at"]
    else:
        booking.overstay_status = OverstayStatus.COLLECTED
        fields = ["overstay_status", "overstay_needs_review", "updated_at"]
    booking.overstay_needs_review = False  # an owner / admin has decided
    booking.save(update_fields=fields)
    meta = {"amount": str(due), **({"override_note": note} if note else {})}
    services.log_event(
        booking,
        actor=operator,
        from_status=booking.status,
        to_status=booking.status,
        reason="fee_collected",
        meta=meta,
    )
    services.audit_booking(
        booking, actor=operator, action="booking.fee_collected", before={}, after=meta
    )
