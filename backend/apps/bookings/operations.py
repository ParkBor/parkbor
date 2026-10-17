"""Pieces shared by the gate operations: check-in, check-out, walk-in, manual slot status (Step 9).

Lock order of every gate write: the lot row FIRST (so all of a lot's writers queue on it and
``free_slots`` recounts are never lost), then the booking row, then the slot row; a writer that
also needs the expired holds of the lot releases them right after the lot lock (ARCHITECTURE
10.8: lot -> expired holds -> user -> vehicle -> slot -> booking; the gate takes the booking
before the slot like ``extend_booking`` does: it never needs the user or vehicle rows, and as
every writer of the lot holds the lot lock first the relative order of the later locks cannot
deadlock). An operator's access is checked twice: cheaply before taking the lot lock (a stranger
must not be able to queue on lots that are not theirs) and again under the lock (access may have
been revoked meanwhile).
"""

import logging
import uuid
from dataclasses import dataclass

from django.db import transaction

from apps.core.exceptions import ApiError
from apps.parking import access
from apps.parking.models import ParkingLot, Slot
from apps.parking.services import audit, recalculate_counters

from . import hooks, selectors

logger = logging.getLogger(__name__)

SCAN_OUTCOME_UNKNOWN = "error"
# Outcomes that are only noise (a forged or garbled code): logged, but no database row per try.
NOT_PERSISTED_OUTCOMES = frozenset({"qr_invalid"})


def error_code(exc: ApiError) -> str:
    """Machine code of an API error (the part the operator screen switches on)."""
    try:
        return str(exc.detail["code"])
    except (KeyError, TypeError):
        return SCAN_OUTCOME_UNKNOWN


@dataclass
class ScanTrace:
    """What the server itself resolved while handling one attempt, for the audit line. Ids are
    only filled in once the booking is known to exist AND the operator may see its lot, so a
    probe of random ids does not write rows that name real bookings."""

    booking_id: object = None
    lot_id: object = None


def audit_scan(
    action: str, operator, outcome: str, trace: ScanTrace, *, extra: dict | None = None
) -> None:
    """One audit line per gate attempt, successful or not. The QR token is NEVER recorded: only
    the outcome code and the ids the server itself resolved. A forged code (``qr_invalid``) is
    logged only (it would otherwise let anyone fill the table).

    FAIL-OPEN: this runs after the gate's own transaction has committed (or failed with its own
    answer), so a broken audit table must neither turn a successful check-in into a 500 nor
    replace the real 409 / 400 the operator is about to see. The failure is logged loudly."""
    after = {"outcome": outcome, **(extra or {})}
    if trace.booking_id is not None:
        after["booking"] = str(trace.booking_id)
    if trace.lot_id is not None:
        after["lot"] = str(trace.lot_id)
    try:
        with transaction.atomic():  # a savepoint: a failed insert must not poison an outer tx
            audit(
                actor=operator,
                action=action,
                obj_id=trace.booking_id or trace.lot_id or uuid.UUID(int=0),
                before={},
                after=after,
                persist=outcome not in NOT_PERSISTED_OUTCOMES,
            )
    except Exception:  # noqa: BLE001 - fail open, see the docstring
        logger.exception("could not audit %s (%s)", action, outcome)


def locate(operator, booking_id, *, active_only: bool = True):
    """(lot id of the booking or None, may `operator` operate that lot?). Two queries, no lock:
    a cheap gate in front of the lot lock; the real check is repeated under the lock."""
    lot_id = selectors.lot_id_of_booking(booking_id)
    if lot_id is None:
        return None, False
    allowed = access.get_operable_lot(operator, lot_id, active_only=active_only) is not None
    return lot_id, allowed


def still_operable(operator, lot: ParkingLot, *, active_only: bool = True) -> bool:
    """Access re-check once the lot row is locked."""
    return access.get_operable_lot(operator, lot.pk, active_only=active_only) is not None


def set_slot_status_locked(lot: ParkingLot, slot: Slot, status: str) -> None:
    """Set the PHYSICAL slot status and recount ``free_slots``. The caller holds the lot lock and
    the slot lock (``sync_slot_status`` is the self-locking variant; it cannot be nested because
    its deadlock retry must stay outermost)."""
    if slot.status != status:
        slot.status = status
        slot.save(update_fields=["status"])
    recalculate_counters(lot)
    transaction.on_commit(lambda: hooks.publish_availability_changed(lot.pk))
    transaction.on_commit(lambda: hooks.publish_slot_status(lot.pk, slot.pk, slot.status))
