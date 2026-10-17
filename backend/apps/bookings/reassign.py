"""Move a waiting booking off a slot that an overstaying car blocks (ARCHITECTURE 10.7).

``OVERSTAY`` keeps its slot taken until check-out, so the next CONFIRMED booking of that slot
would arrive at an occupied space. Every minute (after ``detect_overstays``) a CONFIRMED booking
that starts within ``BOOKING_OVERSTAY_REASSIGN_MINUTES`` (or has started) and shares a slot with
an OVERSTAY car is given another free slot of the SAME type for the SAME period, chosen by the
normal ranking (``build_pool`` also skips slots that are physically taken when the booking starts
soon). Price and QR do not change (the QR names the lot, not the slot). If no slot is free
nothing moves and ``hooks.overstay_conflict`` fires (notifications: Step 10).

One booking per transaction, lot lock first; the EXCLUDE constraints stay the last guard (a lost
race just tries the next candidate). Idempotent.
"""

import logging
from datetime import datetime

from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError, transaction
from django.db.models import Exists, OuterRef
from django.utils import timezone

from . import hooks, selectors, services, sweeps
from .allocation import rank_slots
from .conf import get_config
from .models import Booking, BookingEvent
from .state import BookingStatus

logger = logging.getLogger(__name__)

SWEEP_LOCK_TIMEOUT_SECONDS = 5


def _blocked_ids(now: datetime, limit: int | None) -> list:
    """CONFIRMED bookings starting soon (or running) on a slot that holds an OVERSTAY car."""
    cfg = get_config()
    overstaying = Booking.objects.filter(status=BookingStatus.OVERSTAY, slot_id=OuterRef("slot_id"))
    queryset = Booking.objects.filter(
        status=BookingStatus.CONFIRMED,
        starts_at__lt=now + cfg.overstay_reassign,
        ends_at__gt=now,
    ).filter(Exists(overstaying))
    return sweeps.due_ids(queryset, "starts_at", limit)


def resolve_overstay_conflicts(now: datetime | None = None, limit: int | None = None) -> int:
    """Move every blocked booking that can be moved; returns how many moved."""
    if get_config().overstay_reassign.total_seconds() <= 0:
        return 0
    now = now or timezone.now()
    moved = 0
    for booking_id in _blocked_ids(now, limit):
        try:
            moved += bool(_reassign_one(booking_id, now))
        except Exception:  # noqa: BLE001 - one bad booking must not stop the rest
            logger.exception("booking %s: reassigning failed", booking_id)
    return moved


@services.retrying
def _reassign_one(booking_id, now: datetime) -> bool:
    with transaction.atomic():
        services.set_local_timeouts(SWEEP_LOCK_TIMEOUT_SECONDS)
        lot_id = selectors.lot_id_of_booking(booking_id)
        if lot_id is None:
            return False
        services.lock_lot(lot_id)
        services.release_overdue_holds(lot_id, now)  # lapsed holds must not look like taken slots
        try:
            booking = services.lock_booking_row(booking_id)
        except ObjectDoesNotExist:
            return False
        if not _still_blocked(booking, now):
            return False
        target = _pick_slot(booking, lot_id, now)
        if target is None:
            _report_conflict_once(booking, lot_id)
            return False
        return _move(booking, target, lot_id)


def _report_conflict_once(booking: Booking, lot_id) -> None:
    """No slot to move to: tell the notification hook ONCE per booking (this sweep runs every
    minute; the history line is the marker, so a restart or a second worker does not repeat it)."""
    if BookingEvent.objects.filter(booking=booking, reason="overstay_conflict").exists():
        return
    services.log_event(
        booking,
        actor=None,
        from_status=booking.status,
        to_status=booking.status,
        reason="overstay_conflict",
        meta={"slot": str(booking.slot_id)},
    )
    transaction.on_commit(lambda: hooks.overstay_conflict(booking.pk, lot_id))


def _still_blocked(booking: Booking, now: datetime) -> bool:
    return (
        booking.status == BookingStatus.CONFIRMED
        and booking.ends_at > now
        and booking.starts_at < now + get_config().overstay_reassign
        and Booking.objects.filter(status=BookingStatus.OVERSTAY, slot_id=booking.slot_id).exists()
    )


def _pick_slot(booking: Booking, lot_id, now: datetime):
    """The best free slot of the booking's type (locked), or None."""
    cfg = get_config()
    pool = selectors.build_pool(
        lot_id,
        booking.slot.type,
        booking.starts_at,
        booking.ends_at,
        now=now,
        immediate_window=cfg.immediate_window,
        exclude_booking_id=booking.pk,
    )
    for slot_id in rank_slots(pool.candidates, pool.previous_ends, booking.starts_at, None):
        if slot_id == booking.slot_id:
            continue
        slot = services.lock_slot(slot_id)  # SKIP LOCKED: a busy one is skipped
        if slot is not None and not selectors.slot_has_overlap(
            slot.pk, booking.starts_at, booking.ends_at
        ):
            return slot
    return None


def _move(booking: Booking, target, lot_id) -> bool:
    old_slot_id = booking.slot_id
    try:
        with transaction.atomic():  # savepoint: an EXCLUDE violation must not poison the tx
            booking.slot = target
            booking.save(update_fields=["slot", "updated_at"])
    except IntegrityError as exc:
        if services.exclusion_constraint(exc) is None:
            raise
        logger.info("booking %s: target slot taken concurrently; left in place", booking.pk)
        return False
    meta = {"from": str(old_slot_id), "to": str(target.pk)}
    services.log_event(
        booking,
        actor=None,
        from_status=booking.status,
        to_status=booking.status,
        reason="slot_reassigned",
        meta=meta,
    )
    services.audit_booking(
        booking, actor=None, action="booking.slot_reassigned", before={}, after=meta
    )
    transaction.on_commit(lambda: hooks.slot_reassigned(booking.pk, old_slot_id, target.pk, lot_id))
    transaction.on_commit(lambda: hooks.publish_availability_changed(lot_id))
    return True
