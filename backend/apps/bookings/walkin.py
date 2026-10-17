"""Walk-in: a car that arrives without a booking and is registered by the operator (6.3, Step 9).

Model decision (the safest one): a walk-in is an ordinary ``Booking`` row with
``kind = WALK_IN``, ``user = NULL`` and ``vehicle = NULL`` plus the plate snapshot, created
directly ACTIVE. That keeps ONE source of truth for "who occupies the slot": the same EXCLUDE
constraints (slot and plate) protect it against double booking, check-out and the overstay sweep
need no special cases, and no fake "walk-in user" account exists. A CHECK keeps ONLINE bookings
from ever losing their user / vehicle.

Period: ``[now, min(now + BOOKING_WALKIN_MAX_HOURS, next booking on the slot or of the plate
minus BOOKING_WALKIN_BUFFER_MINUTES))``. It is refused when a live booking on the slot or of the
same plate starts within ``BOOKING_WALKIN_MIN_GAP_MINUTES`` (``slot_reserved_soon`` /
``plate_busy``; the latter never says where the other booking is).

The fee is priced at check-out for the whole real stay (``overstay.price_walk_in``: the first
``BOOKING_FREE_MINUTES`` = 10 are free, as for a booking). A walk-in that outstays its period (a
booking waits behind it) turns OVERSTAY like any car, but is still priced as one stay.

Business decision: a walk-in ignores the lot's working hours (the operator is on site and sees
the car), unlike an online booking. At most ``OPERATOR_WALKIN_PER_HOUR`` per operator per hour
(429 ``walk_in_rate_limited``).

Same lock order as everything else: lot (and the lot's expired holds) -> slot -> new row.
"""

from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.attempts import FailureCounter
from apps.core.exceptions import ApiError, NotFoundError
from apps.parking import access
from apps.parking.models import Slot, SlotStatus
from apps.vehicles.plate import InvalidPlate, normalize_plate

from . import operations, selectors, services
from .compat import is_compatible
from .conf import BookingConfig, get_config
from .errors import rule_violation
from .fields import make_period
from .gate_errors import (
    PlateBusy,
    SlotOccupied,
    SlotOutOfService,
    SlotReservedSoon,
    WalkInRateLimited,
)
from .models import Booking, BookingEvent
from .quotes import require_tariff
from .state import BookingKind, BookingStatus, status_write_allowed

ONE_HOUR = timedelta(hours=1)


@dataclass(frozen=True)
class _Arrival:
    """One walk-in attempt, as the transaction sees it."""

    operator: object
    lot_id: object  # filled in once the slot is found
    slot_id: object
    plate: str  # as typed until normalised
    vehicle_type: str
    now: datetime


def register_walk_in(
    *, operator, slot_id, plate_number: str, vehicle_type: str, now: datetime | None = None
) -> Booking:
    """Register a car without a booking in a free slot. Every attempt is audited.

    ``vehicle_type`` is required (it must fit the slot type: the operator can see the car).
    """
    now = (now or timezone.now()).replace(microsecond=0)
    trace = operations.ScanTrace()
    arrival = _Arrival(operator, None, slot_id, plate_number, vehicle_type, now)
    failures = _failures()
    try:
        _refuse_if_flooding(failures, operator)
        booking = _register(arrival, trace)
    except ApiError as exc:
        if exc.status_code < 500 and not isinstance(exc, WalkInRateLimited):
            failures.record(str(operator.pk))  # refusals count too: plate_busy is an oracle
        operations.audit_scan("operator.walk_in", operator, operations.error_code(exc), trace)
        raise
    trace.booking_id = booking.pk
    operations.audit_scan("operator.walk_in", operator, "registered", trace)
    return booking


def _failures() -> FailureCounter:
    return FailureCounter("walkinfail", settings.OPERATOR_WALKIN_FAIL_PER_MINUTE, 60)


def _refuse_if_flooding(failures: FailureCounter, operator) -> None:
    """Too many REFUSED walk-ins in the last minute (probing which plates are booked, or just a
    broken client in a loop): 429 for the rest of the minute, with Retry-After."""
    remaining = failures.seconds_locked(str(operator.pk))
    if remaining:
        error = WalkInRateLimited()
        error.wait = remaining
        raise error


def _register(arrival: _Arrival, trace) -> Booking:
    try:
        plate = normalize_plate(arrival.plate)
    except InvalidPlate as exc:
        raise rule_violation("plate_invalid", str(exc)) from exc
    lot_id = (
        Slot.objects.filter(pk=arrival.slot_id)
        .values_list("zone__parking_lot_id", flat=True)
        .first()
    )
    if lot_id is None or access.get_operable_lot(arrival.operator, lot_id) is None:
        raise NotFoundError("Slot not found.")  # a stranger cannot tell the two cases apart
    trace.lot_id = lot_id
    return _register_tx(replace(arrival, lot_id=lot_id, plate=plate))


@services.retrying
@transaction.atomic
def _register_tx(arrival: _Arrival) -> Booking:
    cfg = get_config()
    services.set_local_timeouts(cfg.lock_timeout_seconds)
    lot = services.lock_lot(arrival.lot_id)  # 1. the lot, always first
    if not operations.still_operable(arrival.operator, lot):
        raise NotFoundError("Slot not found.")
    _enforce_hourly_limit(arrival)
    services.release_overdue_holds(lot.pk, arrival.now)  # else an unswept hold fakes "slot taken"
    slot = services.lock_slot_wait(arrival.slot_id)  # 2. the slot (NotFoundError if it vanished)
    _check_slot(slot, arrival.vehicle_type)
    tariff = require_tariff(
        lot.pk, slot.type
    )  # the fee is priced at check-out: it must be priceable
    end = _period_end(slot.pk, arrival.plate, arrival.now, cfg)
    snapshot = {"price_per_hour": str(tariff.price_per_hour), "rules": tariff.rules}
    booking = _insert(slot, arrival, end, snapshot)
    _record(booking, arrival.operator, slot)
    operations.set_slot_status_locked(lot, slot, SlotStatus.OCCUPIED)
    return booking


def _enforce_hourly_limit(arrival: _Arrival) -> None:
    """At most ``OPERATOR_WALKIN_PER_HOUR`` walk-ins per operator per hour (counted from the
    booking history, under the lot lock): a flood of fake walk-ins is abuse, not a busy gate."""
    recent = BookingEvent.objects.filter(
        actor=arrival.operator, reason="walk_in", created_at__gte=arrival.now - ONE_HOUR
    ).count()
    if recent >= settings.OPERATOR_WALKIN_PER_HOUR:
        raise WalkInRateLimited


def _check_slot(slot: Slot, vehicle_type: str) -> None:
    if slot.status == SlotStatus.OUT_OF_SERVICE:
        raise SlotOutOfService
    if slot.status != SlotStatus.FREE:
        raise SlotOccupied
    if not is_compatible(vehicle_type, slot.type):
        raise rule_violation(
            "vehicle_slot_mismatch", f"A {vehicle_type} vehicle cannot use a {slot.type} slot."
        )


def _period_end(slot_id, plate: str, now: datetime, cfg: BookingConfig) -> datetime:
    """Where the walk-in period ends: the walk-in maximum, or the buffer before the next booking
    of the slot / of the same plate, whichever is first."""
    gap_end = now + cfg.walkin_min_gap
    if selectors.slot_has_overlap(slot_id, now, gap_end):
        raise SlotReservedSoon
    if selectors.vehicle_has_overlap(plate, now, gap_end, now=now):
        raise PlateBusy
    limit = now + cfg.walkin_max
    ends = [limit]
    for kind in ({"slot_id": slot_id}, {"plate": plate}):
        first = selectors.next_live_start(after=gap_end, before=limit, now=now, **kind)
        if first is not None:
            ends.append(first - cfg.walkin_buffer)
    end = min(ends)
    if end <= now:  # a zero minimum gap and a booking starting this very second
        raise SlotReservedSoon
    return end


def _insert(slot: Slot, arrival: _Arrival, end: datetime, snapshot: dict) -> Booking:
    try:
        with transaction.atomic(), status_write_allowed():  # savepoint: EXCLUDE must not poison
            booking = Booking(
                kind=BookingKind.WALK_IN,
                user=None,
                vehicle=None,
                slot=slot,
                vehicle_plate=arrival.plate,
                period=make_period(arrival.now, end),
                status=BookingStatus.ACTIVE,
                amount=0,
                paid_amount=0,
                checked_in_at=arrival.now,
                qr_nonce="",
                tariff_snapshot=snapshot,
            )
            booking.save(force_insert=True)
    except IntegrityError as exc:
        constraint = services.exclusion_constraint(exc)
        if constraint is None:
            raise
        raise (PlateBusy if constraint == services.VEHICLE_EXCLUSION else SlotOccupied) from exc
    return booking


def _record(booking: Booking, operator, slot: Slot) -> None:
    until = booking.ends_at.isoformat()
    services.log_event(
        booking,
        actor=operator,
        from_status="",
        to_status=BookingStatus.ACTIVE,
        reason="walk_in",
        meta={"slot": str(slot.pk), "until": until},
    )
    services.audit_booking(
        booking,
        actor=operator,
        action="booking.walk_in",
        before={},
        after={"status": BookingStatus.ACTIVE, "slot": str(slot.pk), "until": until},
    )
