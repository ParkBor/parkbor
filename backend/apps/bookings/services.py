"""Booking write operations. Views stay thin; every rule and transaction lives here.

Locking (ARCHITECTURE 7.1, mandatory): every operation first locks the parking lot row
(``parking.services.lock_lot``), then the user / vehicle / slot rows it needs, then the booking
row. All booking writers of one lot therefore queue on the lot lock, so no two of them can lock
in opposite orders (no deadlocks), and ``free_slots`` recounts are never lost. The cost is that
bookings of ONE lot are serialised: throughput per lot is bounded by the length of a booking
transaction (a handful of indexed queries). The EXCLUDE constraints are the final guarantee
should anything bypass these rules.

Slot status model (decision, see ARCHITECTURE 10.8): bookings are TIME RANGES. Creating,
confirming, cancelling or expiring a booking does NOT change ``Slot.status`` or the lot's
``free_slots``. Those describe the physical present and change only at check-in/check-out/
walk-in (Step 9), via ``sync_slot_status`` below.

``Booking.status`` changes only through ``_apply_transition`` (state table + BookingEvent +
audit); the model refuses any other status write.
"""

import functools
import logging
import random
import time
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError, OperationalError, connection, transaction
from django.utils import timezone

from apps.core.exceptions import InvalidTransition, NotFoundError
from apps.parking import access
from apps.parking.models import LotStatus, ParkingLot, Slot, SlotStatus
from apps.parking.services import audit, recalculate_counters
from apps.parking.services import lock_lot as _lock_lot
from apps.payments import conf as payments_conf
from apps.vehicles.models import Vehicle

from . import hooks, idempotency, qr, selectors
from .allocation import rank_slots
from .compat import is_compatible
from .conf import BookingConfig, get_config
from .errors import (
    BookingConflict,
    BookingCooldown,
    ExtendUnavailable,
    LockTimeout,
    NoSlotAvailable,
    SerializationRetry,
    VehicleBusy,
    rule_violation,
)
from .fields import make_period
from .hours import fits_working_hours
from .models import Booking, BookingEvent
from .periods import check_duration, floor_minute, validate_period
from .pricing import CENT, calc_price
from .quotes import require_tariff
from .state import BookingStatus, assert_transition, status_write_allowed

logger = logging.getLogger(__name__)

# expire_hold runs this long after the hold ends, so the task never fires a hair early.
EXPIRE_TASK_SLACK_SECONDS = 2
MAX_HOLDS_RELEASED_PER_CREATE = 50
PG_EXCLUSION_VIOLATION = "23P01"
PG_LOCK_NOT_AVAILABLE = "55P03"
PG_DEADLOCK = "40P01"
VEHICLE_EXCLUSION = "booking_vehicle_no_overlap"
DEADLOCK_RETRY_JITTER_SECONDS = (0.01, 0.06)
_PERCENT = Decimal(100)


# --- database error classification --------------------------------------------------------------


def _sqlstate(exc: BaseException) -> str | None:
    return getattr(exc.__cause__, "sqlstate", None)


def _retrying(func):
    """Outermost wrapper of every booking write (apply ABOVE ``@transaction.atomic``).

    * lock wait ran out (55P03)  -> 503 ``lock_timeout``;
    * deadlock (40P01) -> ONE retry after a small random pause, then 503 ``serialization_retry``.
      Booking writers all take the lot lock first so they cannot deadlock with each other; a
      writer that does not (a raw/walk-in writer, Step 9) can, and PostgreSQL then aborts one
      side. The whole transaction was rolled back, so repeating it is safe.
    """

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        for attempt in (1, 2):
            try:
                return func(*args, **kwargs)
            except OperationalError as exc:
                state = _sqlstate(exc)
                if state == PG_LOCK_NOT_AVAILABLE:
                    raise LockTimeout from exc
                if state != PG_DEADLOCK:
                    raise
                if attempt == 2:
                    raise SerializationRetry from exc
                logger.warning("deadlock in %s: retrying once", func.__name__)
                time.sleep(random.uniform(*DEADLOCK_RETRY_JITTER_SECONDS))  # noqa: S311

    return wrapper


def _exclusion_constraint(exc: IntegrityError) -> str | None:
    """Name of the violated EXCLUDE constraint ("" if unnamed); None for any other error."""
    if _sqlstate(exc) != PG_EXCLUSION_VIOLATION:
        return None
    diag = getattr(exc.__cause__, "diag", None)
    return getattr(diag, "constraint_name", None) or ""


# --- locks ------------------------------------------------------------------------------------


def _lock_slot(slot_id) -> Slot | None:
    """FOR NO KEY UPDATE SKIP LOCKED on one working slot (None: locked, gone or out of
    service). NO KEY keeps foreign-key checks on the slot from queueing behind us. A no-op on
    SQLite."""
    return (
        Slot.objects.select_for_update(skip_locked=True, of=("self",), no_key=True)
        .filter(pk=slot_id)
        .exclude(status=SlotStatus.OUT_OF_SERVICE)
        .first()
    )


def _lock_slot_wait(slot_id) -> Slot:
    """Plain FOR UPDATE (waits). Safe because the lot lock is already held by every caller."""
    try:
        return Slot.objects.select_for_update(of=("self",)).get(pk=slot_id)
    except ObjectDoesNotExist as exc:
        raise NotFoundError from exc


def _lock_booking_row(booking_id) -> Booking:
    return (
        Booking.objects.select_for_update(of=("self",))
        .select_related("slot__zone")
        .get(pk=booking_id)
    )


def _lock_lot_and_booking(booking_id, user=None) -> tuple[ParkingLot, Booking]:
    """Lot first, then the booking row, with the booking re-read under the lock."""
    lot_id = selectors.lot_id_of_booking(booking_id, user)
    if lot_id is None:
        raise NotFoundError("Booking not found.")
    lot = _lock_lot(lot_id)
    try:
        return lot, _lock_booking_row(booking_id)
    except ObjectDoesNotExist as exc:
        raise NotFoundError("Booking not found.") from exc


def _set_local_timeouts(lock_seconds: int, statement_seconds: int | None = None) -> None:
    """Bound row-lock waits (and optionally statement time) of the CURRENT transaction
    (PostgreSQL ``set_config(..., is_local=true)``), so a stuck lot queue turns into a retryable
    503 instead of hanging requests. Call it first thing inside the atomic block: the setting
    lasts until the end of the OUTERMOST transaction, so if a caller wraps us in its own
    ``atomic()`` (we then only open a savepoint) it also applies to the caller's later work."""
    if connection.vendor != "postgresql":
        return
    with connection.cursor() as cursor:
        cursor.execute("SELECT set_config('lock_timeout', %s, true)", [f"{lock_seconds}s"])
        if statement_seconds is not None:
            cursor.execute(
                "SELECT set_config('statement_timeout', %s, true)", [f"{statement_seconds}s"]
            )


def _set_lock_timeout(cfg: BookingConfig) -> None:
    _set_local_timeouts(cfg.lock_timeout_seconds)


# Public names for payments (Step 8): same lock order (lot -> booking), same deadlock retry.
retrying = _retrying
lock_lot_and_booking = _lock_lot_and_booking
set_local_timeouts = _set_local_timeouts


# --- helpers ----------------------------------------------------------------------------------


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _log_event(booking, *, actor, from_status, to_status, reason, meta=None) -> BookingEvent:
    return BookingEvent.objects.create(
        booking=booking,
        actor=actor,
        from_status=from_status,
        to_status=to_status,
        reason=reason,
        meta=meta or {},
    )


def _audit(booking, *, actor, action, before, after) -> None:
    audit(actor=actor, action=action, obj_id=booking.pk, before=before, after=after)


def _lot_id_of(booking: Booking):
    return booking.slot.zone.parking_lot_id


def _apply_transition(
    booking: Booking,
    to: str,
    *,
    actor,
    reason,
    audit_action,
    fields=None,
    meta=None,
    redact: frozenset[str] = frozenset(),
) -> Booking:
    """THE way a booking changes status: state table, row update, event, audit.

    The caller holds the lot and booking locks and has re-read `booking` under them. One UPDATE
    writes the status and every extra field; fields named in `redact` (secrets such as a fresh
    QR nonce) are saved but never copied into the audit line.
    """
    assert_transition(booking.status, to)
    before = booking.status
    fields = fields or {}
    with status_write_allowed():
        booking.status = to
        for name, value in fields.items():
            setattr(booking, name, value)
        booking.save(update_fields=["status", "updated_at", *fields])
    _log_event(booking, actor=actor, from_status=before, to_status=to, reason=reason, meta=meta)
    _audit(
        booking,
        actor=actor,
        action=audit_action,
        before={"status": before},
        after={"status": to, **{k: str(v) for k, v in fields.items() if k not in redact}},
    )
    lot_id = _lot_id_of(booking)
    user_id = booking.user_id
    transaction.on_commit(lambda: hooks.publish_availability_changed(lot_id))
    transaction.on_commit(
        lambda: hooks.booking_status_changed(booking.pk, user_id, lot_id, to, before)
    )
    return booking


def _get_active_lot(lot_id) -> ParkingLot:
    """Lock the lot (first lock of every write) and make sure drivers may see it."""
    try:
        lot = _lock_lot(lot_id)
    except ObjectDoesNotExist as exc:
        raise NotFoundError("Parking lot not found.") from exc
    if lot.status != LotStatus.ACTIVE:
        raise NotFoundError("Parking lot not found.")
    return lot


# --- create -----------------------------------------------------------------------------------


def _release_overdue_holds(lot_id, now: datetime) -> None:
    """Expire this lot's unpaid holds that ran out but were not swept yet, so they cannot cause
    a false "no slot available". Runs under the lot lock."""
    for booking_id in selectors.overdue_holds_in_lot(lot_id, now, MAX_HOLDS_RELEASED_PER_CREATE):
        booking = _lock_booking_row(booking_id)
        if _hold_is_over(now)(booking):
            _apply_transition(
                booking,
                BookingStatus.EXPIRED,
                actor=None,
                reason="hold_expired",
                audit_action="booking.expire",
            )


def _checked_vehicle(user, vehicle, slot_type: str) -> Vehicle:
    if vehicle.user_id != user.pk:
        raise rule_violation("vehicle_not_found", "Vehicle not found.")
    try:
        fresh = Vehicle.objects.select_for_update(no_key=True).get(pk=vehicle.pk, is_archived=False)
    except ObjectDoesNotExist as exc:
        raise rule_violation("vehicle_not_found", "Vehicle not found.") from exc
    if not is_compatible(fresh.type, slot_type):
        raise rule_violation(
            "vehicle_slot_mismatch", f"A {fresh.type} vehicle cannot use a {slot_type} slot."
        )
    return fresh


def _enforce_user_limits(user, now: datetime, cfg: BookingConfig) -> None:
    """Anti slot-hoarding, counted under the lot lock plus the user's own row lock."""
    if selectors.abandoned_holds(user, now - cfg.cooldown_window) >= cfg.cooldown_threshold:
        raise BookingCooldown
    pending, live = selectors.user_booking_counts(user, now)
    if pending >= cfg.max_pending or live >= cfg.max_active:
        raise rule_violation(
            "booking_limit_reached", "You have too many open bookings. Pay or cancel one first."
        )


def _insert_booking(*, ranked, attempts, **fields) -> Booking:
    """Try the best slots in order until one can be locked AND inserted."""
    for slot_id in ranked[:attempts]:
        slot = _lock_slot(slot_id)
        if slot is None:  # locked by someone else, gone, or out of service: take the next
            continue
        try:
            with transaction.atomic():  # savepoint: an EXCLUDE violation must not poison the tx
                booking = Booking(slot=slot, **fields)
                booking.save(force_insert=True)
        except IntegrityError as exc:
            constraint = _exclusion_constraint(exc)
            if constraint is None:
                raise  # a real integrity problem, not a lost race: never disguise it
            if constraint == VEHICLE_EXCLUSION:
                raise VehicleBusy from exc
            logger.info("slot %s taken concurrently (EXCLUDE); trying the next one", slot_id)
            continue
        return booking
    raise NoSlotAvailable


def _schedule_expiry(booking_id, countdown: int) -> None:
    from . import tasks

    try:
        tasks.expire_hold.apply_async((str(booking_id),), countdown=countdown)
    except Exception:  # noqa: BLE001 - the booking is committed; the beat sweep will expire it
        logger.exception("could not schedule expire_hold for booking %s", booking_id)


def _record_creation(booking: Booking, user, cfg: BookingConfig) -> None:
    _log_event(
        booking,
        actor=user,
        from_status="",
        to_status=booking.status,
        reason="created",
        meta={"slot": str(booking.slot_id)},
    )
    _audit(
        booking,
        actor=user,
        action="booking.create",
        before={},
        after={
            "status": booking.status,
            "slot": str(booking.slot_id),
            "amount": str(booking.amount),
        },
    )
    countdown = int(cfg.hold.total_seconds()) + EXPIRE_TASK_SLACK_SECONDS
    transaction.on_commit(lambda: _schedule_expiry(booking.pk, countdown))
    transaction.on_commit(lambda: hooks.publish_availability_changed(_lot_id_of(booking)))


@transaction.atomic
def _create_booking_tx(
    *, user, lot_id, slot_type, vehicle, start, end, preferred_slot_id, now, payment_provider
) -> Booking:
    cfg = get_config()
    _set_lock_timeout(cfg)
    lot = _get_active_lot(lot_id)  # 1. lot lock (always first)
    _release_overdue_holds(lot.pk, now)
    # Lock order (ARCHITECTURE 10.8): lot -> overdue holds of the lot -> user -> vehicle -> slot
    # -> booking. NO KEY: the foreign keys pointing at these rows must not queue behind us.
    type(user).objects.select_for_update(no_key=True).get(pk=user.pk)
    vehicle = _checked_vehicle(user, vehicle, slot_type)
    if lot.owner_id == user.pk or access.has_active_assignment(user.pk, lot.pk):
        # the owner and the lot's own staff cannot book (or pay for) a slot in their lot
        raise rule_violation("own_lot_booking", "You cannot book a slot in your own parking lot.")
    _enforce_user_limits(user, now, cfg)
    start, end = validate_period(lot=lot, start=start, end=end, now=now, cfg=cfg)
    tariff = require_tariff(lot.pk, slot_type)
    if selectors.vehicle_has_overlap(vehicle.plate_number, start, end, now=now):
        raise VehicleBusy
    pool = selectors.build_pool(
        lot.pk, slot_type, start, end, now=now, immediate_window=cfg.immediate_window
    )
    ranked = rank_slots(pool.candidates, pool.previous_ends, start, preferred_slot_id)
    price = calc_price(  # frozen into Booking.amount: later tariff changes never touch it
        price_per_hour=tariff.price_per_hour,
        rules=tariff.rules,
        start=start,
        end=end,
        occupancy=pool.occupancy,
        config=cfg.pricing,
    )
    if price.total <= 0:  # nothing to collect: a payment of 0 so'm cannot exist at any provider
        raise rule_violation("price_zero", "This booking has no price, so it cannot be booked.")
    booking = _insert_booking(  # 3. slot lock inside
        ranked=ranked,
        attempts=1 if preferred_slot_id else cfg.max_pick_attempts,
        user=user,
        vehicle=vehicle,
        vehicle_plate=vehicle.plate_number,
        period=make_period(start, end),
        amount=price.total,
        hold_expires_at=now + cfg.hold,
        payment_provider=payment_provider,
        qr_nonce=qr.new_nonce(),
        tariff_snapshot={"price_per_hour": str(tariff.price_per_hour), "rules": tariff.rules},
    )
    _record_creation(booking, user, cfg)
    return booking


@_retrying
def create_booking(
    *,
    user,
    lot_id,
    slot_type: str,
    vehicle,
    start: datetime,
    end: datetime,
    preferred_slot_id=None,
    payment_provider: str | None = None,
    now: datetime | None = None,
) -> Booking:
    """Create a PENDING_PAYMENT booking holding a slot for ``BOOKING_HOLD_MINUTES``.
    ``payment_provider`` ("payme" | "click") picks the checkout; None = the configured default."""
    return _create_booking_tx(
        user=user,
        lot_id=lot_id,
        slot_type=slot_type,
        vehicle=vehicle,
        start=start,
        end=end,
        preferred_slot_id=preferred_slot_id,
        now=now or timezone.now(),
        payment_provider=payment_provider or payments_conf.get_config().default_provider,
    )


def create_booking_idempotent(*, idempotency_key: str, **params) -> tuple[Booking, bool]:
    """``create_booking`` behind the Idempotency-Key store. Returns (booking, created).

    A replay returns the booking in whatever status it has reached (even EXPIRED/CANCELLED):
    the client is shown the truth, not a second booking.
    """
    user = params["user"]
    # Resolve the default BEFORE fingerprinting: "omitted" and "the default, spelled out" are
    # the same request.
    params["payment_provider"] = (
        params.get("payment_provider") or payments_conf.get_config().default_provider
    )
    fp = idempotency.fingerprint(params)
    started = idempotency.begin(user.pk, idempotency_key, fp)
    if started.replay_booking_id is not None:
        booking = selectors.get_user_booking(user, started.replay_booking_id)
        if booking is None:
            raise NotFoundError("Booking not found.")
        return booking, False
    try:
        idempotency.refresh(user.pk, idempotency_key, started.token)
        booking = create_booking(**params)
    except BaseException:
        _release_quietly(user.pk, idempotency_key, started.token)
        raise
    try:
        idempotency.complete(user.pk, idempotency_key, started.token, booking.pk, fp)
    except Exception:  # noqa: BLE001 - the booking exists; losing the replay record is the lesser harm
        logger.exception("could not record idempotency result for booking %s", booking.pk)
    return booking, True


def _release_quietly(user_id, key: str, token: str) -> None:
    """Releasing must never replace the real error the caller is about to see."""
    try:
        idempotency.release(user_id, key, token)
    except Exception:  # noqa: BLE001
        logger.exception("could not release the idempotency marker")


# --- payment confirmation (called by payments, Step 8) ------------------------------------------


@_retrying
@transaction.atomic
def rotate_qr_nonce(booking: Booking) -> Booking:
    """Replace the QR nonce and mark it unspent: every earlier token stops working (Step 9
    uses this e.g. after a failed scan or when the driver asks for a fresh code)."""
    _lot, row = _lock_lot_and_booking(booking.pk)
    row.qr_nonce = qr.new_nonce()
    row.qr_nonce_used_at = None
    row.save(update_fields=["qr_nonce", "qr_nonce_used_at", "updated_at"])
    _audit(row, actor=None, action="booking.qr_rotate", before={}, after={})
    return row


# --- cancel -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class CancelPreview:
    can_cancel: bool
    refund_percent: int
    refund_amount: Decimal


def refund_percent_for(starts_at: datetime, now: datetime) -> int:
    """Cancellation policy (ARCHITECTURE 6.2): an hour or more before the start -> full;
    less -> late percent; the start instant or later -> nothing."""
    policy = get_config().cancel_policy
    if now >= starts_at:
        return policy.after_start_percent
    if starts_at - now >= timedelta(minutes=policy.full_refund_minutes):
        return policy.full_percent
    return policy.late_percent


def _refund_for(booking: Booking, now: datetime) -> tuple[int, Decimal]:
    """Policy percent of what was actually PAID (never of the price, never above the payment)."""
    if booking.status != BookingStatus.CONFIRMED or booking.paid_amount <= 0:
        return 0, Decimal("0.00")
    percent = refund_percent_for(booking.starts_at, now)
    refund = min(_money(booking.paid_amount * percent / _PERCENT), booking.paid_amount)
    return percent, refund


def cancel_preview(booking: Booking, now: datetime | None = None) -> CancelPreview:
    now = now or timezone.now()
    if booking.status not in (BookingStatus.PENDING_PAYMENT, BookingStatus.CONFIRMED):
        return CancelPreview(can_cancel=False, refund_percent=0, refund_amount=Decimal("0.00"))
    percent, refund = _refund_for(booking, now)
    return CancelPreview(can_cancel=True, refund_percent=percent, refund_amount=refund)


@_retrying
@transaction.atomic
def cancel_booking(*, booking_id, user, now: datetime | None = None) -> Booking:
    """Driver cancels a PENDING_PAYMENT or CONFIRMED booking; the refund follows the policy.
    Cancelling an already CANCELLED booking is a no-op that returns it (safe to retry).

    When ``refund_amount > 0`` a ``payments.Refund`` is created in the SAME transaction and the
    provider call is queued on commit (``payments.send_refund``): a rolled-back cancel leaves no
    refund behind, a committed one is never lost.
    """
    now = now or timezone.now()
    _lot, booking = _lock_lot_and_booking(booking_id, user)
    if booking.status == BookingStatus.CANCELLED:
        return booking
    assert_transition(booking.status, BookingStatus.CANCELLED)
    percent, refund = _refund_for(booking, now)
    cancelled = _apply_transition(
        booking,
        BookingStatus.CANCELLED,
        actor=user,
        reason="user_cancelled",
        audit_action="booking.cancel",
        fields={"cancelled_at": now, "refund_amount": refund},
        meta={"refund_amount": str(refund), "refund_percent": percent},
    )
    if refund > 0:
        hooks.create_refund(cancelled, refund)
    return cancelled


@_retrying
@transaction.atomic
def admin_cancel_booking(
    *, booking_id, actor, note: str = "", now: datetime | None = None
) -> Booking:
    """An ADMIN (any lot) or an OWNER (own lots) cancels a PENDING_PAYMENT or CONFIRMED booking
    by hand (admin panel). A booking cancelled by the lot is not the driver's fault, so
    everything actually PAID is refunded (``refund_amount = paid_amount``, no policy percent);
    the Refund row is created in this transaction like in ``cancel_booking``. Repeating the call
    on a CANCELLED booking is a no-op. ``note`` is already validated by the caller (<= 200
    characters, no phone / card number) and lands in the booking history only.
    """
    now = now or timezone.now()
    _lot, booking = _lock_lot_and_booking(booking_id)
    is_admin = getattr(actor, "role", None) == "ADMIN"
    if not is_admin and _lot.owner_id != actor.pk:
        raise NotFoundError("Booking not found.")  # a foreign lot is indistinguishable
    if booking.status == BookingStatus.CANCELLED:
        return booking
    assert_transition(booking.status, BookingStatus.CANCELLED)
    refund = (
        _money(booking.paid_amount)
        if booking.status == BookingStatus.CONFIRMED
        else Decimal("0.00")
    )
    cancelled = _apply_transition(
        booking,
        BookingStatus.CANCELLED,
        actor=actor,
        reason="admin_cancelled",
        audit_action="booking.admin_cancel",
        fields={"cancelled_at": now, "refund_amount": refund},
        meta={"refund_amount": str(refund), "note": note},
    )
    if refund > 0:
        hooks.create_refund(cancelled, refund)
    return cancelled


# --- extend -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class ExtendResult:
    booking: Booking
    extra_amount: Decimal


def _check_extendable(booking: Booking, lot: ParkingLot, new_end, now, cfg) -> datetime:
    if booking.status not in (BookingStatus.CONFIRMED, BookingStatus.ACTIVE):
        raise InvalidTransition(f"A {booking.status} booking cannot be extended.")
    if booking.ends_at <= now:
        raise InvalidTransition("This booking has already ended.")
    new_end = floor_minute(new_end)
    if new_end <= booking.ends_at:
        raise rule_violation("period_invalid", "The new end must be later than the current end.")
    check_duration(booking.starts_at, new_end, cfg)
    if not fits_working_hours(lot.open_time, lot.close_time, booking.starts_at, new_end):
        raise rule_violation("lot_closed", "The parking lot is closed during this period.")
    return new_end


def _extension_price(booking, lot, slot, new_end, now, cfg) -> Decimal:
    """Only the added time, at today's tariff, in blocks, without a second free window."""
    tariff = require_tariff(lot.pk, slot.type)
    total, free = selectors.count_availability(
        lot.pk, slot.type, booking.ends_at, new_end, now=now, immediate_window=cfg.immediate_window
    )
    occupancy = Decimal(0) if total == 0 else Decimal(total - free) / Decimal(total)
    return calc_price(
        price_per_hour=tariff.price_per_hour,
        rules=tariff.rules,
        start=booking.ends_at,
        end=new_end,
        occupancy=occupancy,
        config=replace(cfg.pricing, free_minutes=0),
    ).total


def _save_extension(booking: Booking, new_end: datetime, extra: Decimal) -> None:
    booking.period = make_period(booking.starts_at, new_end)
    booking.amount = booking.amount + extra
    try:
        with transaction.atomic():
            booking.save(update_fields=["period", "amount", "updated_at"])
    except IntegrityError as exc:
        constraint = _exclusion_constraint(exc)
        if constraint is None:
            raise
        raise (VehicleBusy if constraint == VEHICLE_EXCLUSION else BookingConflict) from exc


@_retrying
@transaction.atomic
def extend_booking(
    *, booking_id, user, new_end: datetime, now: datetime | None = None
) -> ExtendResult:
    """Move the end of a CONFIRMED/ACTIVE booking later; charges only the added time.

    Disabled by default (``BOOKING_EXTEND_ENABLED``) until payments (Step 8) can collect the
    extra amount: the logic below stays, tested, behind that switch.
    """
    cfg = get_config()
    if not cfg.extend_enabled:
        raise ExtendUnavailable
    now = now or timezone.now()
    lot, booking = _lock_lot_and_booking(booking_id, user)
    new_end = _check_extendable(booking, lot, new_end, now, cfg)
    slot = _lock_slot_wait(booking.slot_id)  # lot -> slot -> (booking already locked)
    old_end = booking.ends_at
    if selectors.slot_has_overlap(slot.pk, old_end, new_end, exclude_booking_id=booking.pk):
        raise BookingConflict
    if selectors.vehicle_has_overlap(
        booking.vehicle_plate, old_end, new_end, now=now, exclude_booking_id=booking.pk
    ):
        raise VehicleBusy
    extra = _extension_price(booking, lot, slot, new_end, now, cfg)
    before = {"ends_at": old_end.isoformat(), "amount": str(booking.amount)}
    _save_extension(booking, new_end, extra)
    after = {"ends_at": new_end.isoformat(), "amount": str(booking.amount)}
    _log_event(
        booking,
        actor=user,
        from_status=booking.status,
        to_status=booking.status,
        reason="extended",
        meta={**after, "extra_amount": str(extra)},
    )
    _audit(booking, actor=user, action="booking.extend", before=before, after=after)
    transaction.on_commit(lambda: hooks.publish_availability_changed(lot.pk))
    return ExtendResult(booking=booking, extra_amount=extra)


def _hold_is_over(now):
    return lambda b: (
        b.status == BookingStatus.PENDING_PAYMENT
        and (b.hold_expires_at is None or b.hold_expires_at <= now)
    )


# --- physical slot status (used by check-in / check-out / walk-in, Step 9) -----------------------


@_retrying
@transaction.atomic
def sync_slot_status(slot_id, status: str) -> Slot:
    """Set ``Slot.status`` and recount ``free_slots`` atomically: lot lock -> slot lock ->
    ``parking.services.recalculate_counters`` (the same definition the reconcile task uses)."""
    lot_id = Slot.objects.filter(pk=slot_id).values_list("zone__parking_lot_id", flat=True).first()
    if lot_id is None:
        raise NotFoundError("Slot not found.")
    lot = _lock_lot(lot_id)
    slot = _lock_slot_wait(slot_id)
    slot.status = status
    slot.save(update_fields=["status"])
    recalculate_counters(lot)
    transaction.on_commit(lambda: hooks.publish_availability_changed(lot.pk))
    transaction.on_commit(lambda: hooks.publish_slot_status(lot.pk, slot.pk, status))
    return slot


# ... and for the operator gate (checkin / checkout / walkin, Step 9): same locks, same transition.
lock_lot = _lock_lot
lock_booking_row = _lock_booking_row
lock_slot_wait = _lock_slot_wait
apply_transition = _apply_transition
log_event = _log_event
audit_booking = _audit
release_overdue_holds = _release_overdue_holds
exclusion_constraint = _exclusion_constraint
lock_slot = _lock_slot


# The sweeps (Celery) live in sweeps.py, which imports THIS module. Their public entry points stay
# reachable as ``services.expire_hold`` etc. through a lazy lookup (PEP 562), so neither module
# needs the other at import time and either can be imported first.
_SWEEP_NAMES = frozenset(
    {"detect_overstays", "expire_hold", "expire_overdue_holds", "mark_no_shows"}
)


def __getattr__(name: str):
    if name in _SWEEP_NAMES:
        from . import sweeps

        return getattr(sweeps, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Payment-facing operations: payment_hooks.py, re-exported here (imported last: needs the above).
from .payment_hooks import (  # noqa: E402, F401
    cancel_after_provider_refund,
    confirm_booking,
    confirm_locked,
    extend_hold_for_payment,
    log_booking_event,
)
