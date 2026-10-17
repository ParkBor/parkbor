"""Celery sweeps over bookings (ARCHITECTURE 10.7, 10.8): expire unpaid holds, mark no-shows,
detect overstays. Each booking is handled in its OWN transaction: lot lock -> booking lock ->
guard re-checked -> transition, with short lock/statement timeouts (a busy row is skipped now and
picked up on the next run). They reach the lock helpers through ``services`` at call time, so the
single set of lock functions (and their test patches) stays in ``services``.
"""

import logging
import uuid
from datetime import datetime

from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.utils import timezone

from . import hooks, selectors, services
from .conf import get_config
from .models import Booking
from .state import BookingStatus

logger = logging.getLogger(__name__)

# Celery sweeps never wait long for a lock or run long: a stuck row is skipped and retried.
SWEEP_LOCK_TIMEOUT_SECONDS = 5
SWEEP_STATEMENT_TIMEOUT_SECONDS = 20


@services.retrying
def _system_transition(booking_id, *, to, reason, audit_action, guard, after=None) -> bool:
    """One booking, its own transaction: lot lock -> booking lock -> re-check -> transition.

    Idempotent: a booking that no longer satisfies `guard` (already handled, paid, cancelled,
    not yet due) is left alone and reported as False. Sweeps use short timeouts of their own:
    a row that is busy is skipped now and picked up on the next run. ``after(booking)`` runs
    inside the same transaction once the transition is done (e.g. to queue a notification).
    """
    with transaction.atomic():
        services._set_local_timeouts(SWEEP_LOCK_TIMEOUT_SECONDS, SWEEP_STATEMENT_TIMEOUT_SECONDS)
        lot_id = selectors.lot_id_of_booking(booking_id)
        if lot_id is None:
            return False
        services._lock_lot(lot_id)
        try:
            booking = services._lock_booking_row(booking_id)
        except ObjectDoesNotExist:
            return False
        if not guard(booking):
            return False
        services._apply_transition(
            booking, to, actor=None, reason=reason, audit_action=audit_action
        )
        if after is not None:
            after(booking)
        return True


def _run_batch(ids, **transition) -> int:
    """Handle each booking in isolation: one that raises is logged (id only, no personal data)
    and skipped, never stopping the rest. It stays due, so it is retried next minute; it can
    occupy at most one place of the batch limit."""
    done = failed = 0
    for booking_id in ids:
        try:
            done += bool(_system_transition(booking_id, **transition))
        except Exception:  # noqa: BLE001 - isolation is the point
            failed += 1
            logger.exception("booking %s: %s failed", booking_id, transition["reason"])
    if failed:
        logger.error("%s: %d failed, %d done", transition["reason"], failed, done)
    return done


def due_ids(queryset, order_field: str, limit: int | None) -> list[uuid.UUID]:
    limit = limit or get_config().task_batch_limit
    return list(queryset.order_by(order_field, "id").values_list("pk", flat=True)[:limit])


def expire_hold(booking_id, now: datetime | None = None) -> bool:
    """PENDING_PAYMENT whose hold has run out -> EXPIRED. True if it expired just now."""
    now = now or timezone.now()
    return _system_transition(
        booking_id,
        to=BookingStatus.EXPIRED,
        reason="hold_expired",
        audit_action="booking.expire",
        guard=services._hold_is_over(now),
    )


def expire_overdue_holds(now: datetime | None = None, limit: int | None = None) -> int:
    """Safety-net sweep for lost ``expire_hold`` tasks (broker outage, worker crash)."""
    now = now or timezone.now()
    ids = due_ids(
        Booking.objects.filter(status=BookingStatus.PENDING_PAYMENT, hold_expires_at__lte=now),
        "hold_expires_at",
        limit,
    )
    return _run_batch(
        ids,
        to=BookingStatus.EXPIRED,
        reason="hold_expired",
        audit_action="booking.expire",
        guard=services._hold_is_over(now),
    )


def mark_no_shows(now: datetime | None = None, limit: int | None = None) -> int:
    """CONFIRMED and start + grace < now (nobody checked in) -> NO_SHOW (ARCHITECTURE 10.7)."""
    now = now or timezone.now()
    cutoff = now - get_config().no_show_grace
    ids = due_ids(
        Booking.objects.filter(status=BookingStatus.CONFIRMED, starts_at__lt=cutoff),
        "starts_at",
        limit,
    )
    return _run_batch(
        ids,
        to=BookingStatus.NO_SHOW,
        reason="no_show",
        audit_action="booking.no_show",
        guard=lambda b: b.status == BookingStatus.CONFIRMED and b.starts_at < cutoff,
    )


def _announce_overstay(booking: Booking) -> None:
    lot_id = services._lot_id_of(booking)
    transaction.on_commit(lambda: hooks.overstay_detected(booking.pk, lot_id, booking.user_id))


def detect_overstays(now: datetime | None = None, limit: int | None = None) -> int:
    """ACTIVE and end < now (still parked) -> OVERSTAY (ARCHITECTURE 10.7).

    Each new overstay calls ``hooks.overstay_detected`` after commit (notifications: Step 10).
    The following booking is moved to another slot by ``reassign.resolve_overstay_conflicts``
    (run by the Celery task right after this). An OVERSTAY does not extend ``period``: the
    selectors (``blocks``) keep the slot taken until check-out.
    """
    now = now or timezone.now()
    ids = due_ids(
        Booking.objects.filter(status=BookingStatus.ACTIVE, ends_at__lt=now), "ends_at", limit
    )
    return _run_batch(
        ids,
        to=BookingStatus.OVERSTAY,
        reason="overstay",
        audit_action="booking.overstay",
        guard=lambda b: b.status == BookingStatus.ACTIVE and b.ends_at < now,
        after=_announce_overstay,
    )
