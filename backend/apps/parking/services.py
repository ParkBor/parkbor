"""Write operations for parking. Views stay thin; all rules and transactions live here.

Concurrency rules:
* every mutation that touches slots first locks the parent lot row (``_lock_lot``), so the
  denormalised counters are recomputed from a consistent view;
* updates re-read the row under lock and write only the changed columns (``update_fields``), so
  a stale in-memory instance can never overwrite e.g. a moderation decision made meanwhile;
* uniqueness races surface as IntegrityError and are translated to a 409 ``Conflict``.
"""

import logging
import math
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.db.models.deletion import ProtectedError
from django.utils import timezone

from apps.core import events
from apps.core.exceptions import (
    Conflict,
    DomainPermissionDenied,
    DomainValidationError,
    InvalidTransition,
)
from apps.core.geo import make_point, make_polygon
from apps.core.geomath import (
    DEFAULT_GEOHASH_PRECISION,
    geohash_cell_radius_m,
    geohash_decode,
    geohash_encode,
    haversine_m,
)
from apps.core.permissions import is_super_admin
from apps.routing import osrm_client

from . import nearby_cache, selectors
from .models import LotStatus, ParkingLot, Slot, SlotStatus, SlotType, Tariff, Zone
from .ranking import (
    CANDIDATE_FACTOR,
    MAX_RADIUS_M,
    MIN_RESULTS,
    NearbyLot,
    NearbyQuery,
    NearbyResult,
    NearbySearchResult,
    compute_scores,
    expansion_steps,
    is_open_now,
    scoring_metric,
    sort_results,
)
from .validators import generate_slot_codes

logger = logging.getLogger(__name__)
audit_logger = logging.getLogger("habi.audit")

# Allowed moderation transitions: action -> (allowed source statuses, target status)
LOT_TRANSITIONS = {
    "approve": ({LotStatus.PENDING_REVIEW}, LotStatus.ACTIVE),
    "suspend": ({LotStatus.PENDING_REVIEW, LotStatus.ACTIVE}, LotStatus.SUSPENDED),
    "restore": ({LotStatus.SUSPENDED}, LotStatus.ACTIVE),
}

# Public-facing fields: an owner changing them on an ACTIVE lot sends it back to review, so an
# approved listing cannot be swapped for something else without an admin seeing it. (Chosen over
# "audit only": it needs no new infrastructure and closes the hole immediately.)
REVIEW_FIELDS = ("name", "address", "location", "area")


def audit(*, actor, action: str, obj_id, before: dict, after: dict, persist: bool = True) -> None:
    """Record an important action (ARCHITECTURE 15 "Audit").

    * ``persist`` (default): one ``audit.AuditLog`` row, written NOW inside the caller's
      transaction, so it commits or rolls back together with the change it describes. Personal
      data is stripped (``apps.audit.scrub``). A caller outside a transaction writes immediately
      (that is how a refused scan, whose own transaction was rolled back, is recorded).
    * the ``habi.audit`` logger line is emitted after COMMIT, as before (a rolled-back change
      leaves no log line). It carries the same allowlist-filtered data as the row.
    """
    from apps.audit.scrub import scrub

    clean_before, clean_after = scrub(before), scrub(after)
    if persist:
        _write_audit_row(actor, action, obj_id, clean_before, clean_after)
    extra = {
        "audit_actor": str(getattr(actor, "pk", None)),
        "audit_action": action,
        "audit_object": str(obj_id),
        "audit_before": clean_before,
        "audit_after": clean_after,
    }
    transaction.on_commit(lambda: audit_logger.info("audit %s", action, extra=extra))


def _write_audit_row(actor, action: str, obj_id, before: dict, after: dict) -> None:
    """`before` / `after` are already scrubbed."""
    from apps.accounts.models import User
    from apps.audit.models import AuditLog

    AuditLog.objects.create(
        actor=actor if isinstance(actor, User) and actor.pk else None,
        action=action[:64],
        target_type=action.partition(".")[0][:32],
        target_id=str(obj_id)[:64],
        meta={"before": before, "after": after},
    )


def _geo_values(data: dict) -> dict:
    values = dict(data)
    if "location" in values:
        lng, lat = values["location"]
        values["location"] = make_point(lng, lat)
    if values.get("area") is not None:
        values["area"] = make_polygon(values["area"])
    return values


def _lock_lot(lot_id) -> ParkingLot:
    """Lock and return the lot row (SELECT ... FOR UPDATE; a no-op on SQLite test DBs)."""
    return ParkingLot.objects.select_for_update().get(pk=lot_id)


def lock_lot(lot_id) -> ParkingLot:
    """Public name of the lot lock for other apps (bookings): same function, same lock order."""
    return _lock_lot(lot_id)


@contextmanager
def _conflict_on_integrity(message: str):
    """Run a write in a savepoint; uniqueness/check violations become a 409."""
    try:
        with transaction.atomic():
            yield
    except IntegrityError as exc:
        raise Conflict(message) from exc


def _delete(obj, message: str) -> None:
    try:
        with transaction.atomic():
            obj.delete()
    except ProtectedError as exc:
        raise Conflict(message) from exc


def recalculate_counters(lot: ParkingLot) -> ParkingLot:
    """Recompute denormalised total_slots / free_slots. Call with the lot row locked."""
    counts = Slot.objects.filter(zone__parking_lot=lot).aggregate(
        total=Count("id"), free=Count("id", filter=Q(status=SlotStatus.FREE))
    )
    ParkingLot.objects.filter(pk=lot.pk).update(
        total_slots=counts["total"], free_slots=counts["free"]
    )
    lot.total_slots, lot.free_slots = counts["total"], counts["free"]
    return lot


def announce_availability(lot_id) -> None:
    """After commit, tell the realtime layer the lot's counters changed (the bookings hook
    ``publish_availability_changed`` is the same event; parking cannot import bookings)."""
    transaction.on_commit(lambda: events.emit("availability_changed", lot_id=lot_id))


@dataclass(frozen=True)
class ReconcileResult:
    checked: int
    fixed: int
    failed: int


def reconcile_counters(limit: int | None = None) -> ReconcileResult:
    """Repair drifted ``total_slots`` / ``free_slots`` (ARCHITECTURE 16, every 5 minutes).

    Each lot is handled in its own short transaction under its lot lock (the same lock every
    other counter writer takes), and a lot that fails is logged and skipped so one bad row never
    stops the sweep. The real count is ``recalculate_counters``'s: the single definition of
    "free" used everywhere.
    """
    ids = list(ParkingLot.objects.order_by("id").values_list("pk", flat=True)[:limit])
    fixed = failed = 0
    for lot_id in ids:
        try:
            with transaction.atomic():
                lot = _lock_lot(lot_id)
                before = (lot.total_slots, lot.free_slots)
                recalculate_counters(lot)
                drifted = before != (lot.total_slots, lot.free_slots)
                if drifted:  # the map showed the drifted number: correct it for watchers too
                    announce_availability(lot.pk)
                fixed += drifted
        except Exception:  # noqa: BLE001 - isolation is the point
            failed += 1
            logger.exception("reconcile_free_slots: lot %s failed", lot_id)
    return ReconcileResult(checked=len(ids), fixed=fixed, failed=failed)


# --- parking lots -----------------------------------------------------------------------------


@transaction.atomic
def create_lot(*, data: dict) -> ParkingLot:
    """New lots always start in PENDING_REVIEW, regardless of who creates them."""
    with _conflict_on_integrity("Parking lot could not be created."):
        return ParkingLot.objects.create(**_geo_values(data), status=LotStatus.PENDING_REVIEW)


@transaction.atomic
def update_lot(*, lot: ParkingLot, data: dict, actor) -> ParkingLot:
    current = _lock_lot(lot.pk)
    values = _geo_values(data)
    needs_review = (
        not is_super_admin(actor)
        and current.status == LotStatus.ACTIVE
        and any(f in values and getattr(current, f) != values[f] for f in REVIEW_FIELDS)
    )
    for field, value in values.items():
        setattr(current, field, value)
    fields = list(values)
    if needs_review:
        current.status = LotStatus.PENDING_REVIEW
        fields.append("status")
        audit(
            actor=actor,
            action="parking.review_required",
            obj_id=current.pk,
            before={"status": LotStatus.ACTIVE},
            after={"status": LotStatus.PENDING_REVIEW},
        )
    if fields:
        with _conflict_on_integrity("Parking lot could not be updated."):
            current.save(update_fields=fields)
    return current


@transaction.atomic
def change_lot_status(*, lot: ParkingLot, actor, action: str) -> ParkingLot:
    """Moderation (approve/suspend/restore). Only ADMIN may do it."""
    if not is_super_admin(actor):
        raise DomainPermissionDenied("Only an administrator can change a parking lot's status.")
    current = _lock_lot(lot.pk)
    sources, target = LOT_TRANSITIONS[action]
    if current.status not in sources:
        raise InvalidTransition(f"Cannot {action} a lot in status {current.status}.")
    before = current.status
    current.status = target
    current.save(update_fields=["status"])
    audit(
        actor=actor,
        action=f"parking.{action}",
        obj_id=current.pk,
        before={"status": before},
        after={"status": target},
    )
    return current


@transaction.atomic
def delete_lot(*, lot: ParkingLot, actor) -> None:
    current = _lock_lot(lot.pk)
    if current.status == LotStatus.ACTIVE:
        raise Conflict("An active parking lot cannot be deleted; suspend it first.")
    _delete(current, "This parking lot is still referenced (e.g. by bookings).")
    audit(actor=actor, action="parking.delete", obj_id=lot.pk, before={}, after={})


# --- zones ------------------------------------------------------------------------------------


@transaction.atomic
def save_zone(*, instance: Zone | None, data: dict) -> Zone:
    with _conflict_on_integrity("A zone with this name already exists."):
        if instance is None:
            return Zone.objects.create(**data)
        for field, value in data.items():
            setattr(instance, field, value)
        if data:  # an empty PATCH must not rewrite the whole row
            instance.save(update_fields=list(data))
        return instance


@transaction.atomic
def delete_zone(*, zone: Zone) -> None:
    lot = _lock_lot(zone.parking_lot_id)
    _delete(zone, "This zone is still referenced (e.g. by bookings).")
    recalculate_counters(lot)


# --- slots ------------------------------------------------------------------------------------


@transaction.atomic
def save_slot(*, instance: Slot | None, data: dict) -> Slot:
    """Create or update one slot, keeping the lot counters consistent."""
    if instance is None:
        lot = _lock_lot(data["zone"].parking_lot_id)
        with _conflict_on_integrity("A slot with this code already exists in the zone."):
            slot = Slot.objects.create(**data)
    else:
        if "zone" in data and data["zone"].pk != instance.zone_id:
            raise DomainValidationError("A slot cannot be moved to another zone.")
        lot = _lock_lot(instance.zone.parking_lot_id)
        slot = Slot.objects.get(pk=instance.pk)  # fresh row, written under the lot lock
        fields = [f for f in data if f != "zone"]
        for field in fields:
            setattr(slot, field, data[field])
        if fields:
            with _conflict_on_integrity("A slot with this code already exists in the zone."):
                slot.save(update_fields=fields)
    recalculate_counters(lot)
    announce_availability(lot.pk)
    return slot


@transaction.atomic
def delete_slot(*, slot: Slot) -> None:
    lot = _lock_lot(slot.zone.parking_lot_id)
    _delete(slot, "This slot is still referenced (e.g. by bookings).")
    recalculate_counters(lot)
    announce_availability(lot.pk)


@transaction.atomic
def bulk_create_slots(
    *,
    zone: Zone,
    prefix: str,
    start: int,
    end: int,
    slot_type: str = SlotType.STANDARD,
    distance_to_entrance: int = 0,
) -> list[Slot]:
    """Create slots prefix-start..prefix-end in a zone (e.g. A-1..A-50); all or nothing."""
    try:
        codes = generate_slot_codes(prefix, start, end)
    except ValueError as exc:
        raise DomainValidationError(str(exc)) from exc
    lot = _lock_lot(zone.parking_lot_id)
    existing = set(zone.slots.filter(code__in=codes).values_list("code", flat=True))
    if existing:
        raise Conflict(f"Codes already exist: {sorted(existing)[:5]}")
    with _conflict_on_integrity("Some slot codes already exist in the zone."):
        slots = Slot.objects.bulk_create(
            [
                Slot(
                    zone=zone,
                    code=code,
                    type=slot_type,
                    distance_to_entrance=distance_to_entrance,
                )
                for code in codes
            ]
        )
    recalculate_counters(lot)
    announce_availability(lot.pk)
    return slots


# --- tariffs ----------------------------------------------------------------------------------


@transaction.atomic
def save_tariff(*, instance: Tariff | None, data: dict) -> Tariff:
    with _conflict_on_integrity("A tariff for this slot type already exists in the lot."):
        if instance is None:
            return Tariff.objects.create(**data)
        for field, value in data.items():
            setattr(instance, field, value)
        if data:  # an empty PATCH must not rewrite the whole row
            instance.save(update_fields=list(data))
        return instance


# --- nearby search (driver API; ARCHITECTURE 10.1) --------------------------------------------

# Nearest lots kept per geohash cell; >= 3 * max limit (50) so one entry serves any limit.
CELL_CANDIDATE_CAP = CANDIDATE_FACTOR * 50


def cell_fetch_radius_m(cell: str) -> int:
    """One radius for all expansion steps: the maximum search radius, widened by the cell's
    covering radius (+1 % and 50 m for the sphere/spheroid difference between Haversine and
    PostGIS geography), so any point of the cell can see everything within MAX_RADIUS_M."""
    return math.ceil(MAX_RADIUS_M + math.ceil(geohash_cell_radius_m(cell)) * 1.01 + 50)


def _cell_candidates(query: NearbyQuery, cell: str) -> list[NearbyLot]:
    """The nearest <= CELL_CANDIDATE_CAP lots around the cell centre (KNN order), one query per
    cell for every radius step. Complete for the whole cell up to MAX_RADIUS_M unless the cap is
    hit; a capped list is guaranteed only up to D_cap - cell_radius, so it is not cached."""
    key = nearby_cache.cache_key(cell=cell, slot_type=query.slot_type)
    cached = nearby_cache.load(key)
    if cached is not None:
        return cached
    centre_lat, centre_lng, _, _ = geohash_decode(cell)
    lots = selectors.nearby_candidates(
        lat=centre_lat,
        lng=centre_lng,
        radius_m=cell_fetch_radius_m(cell),
        slot_type=query.slot_type,
        cap=CELL_CANDIDATE_CAP,
    )
    if len(lots) >= CELL_CANDIDATE_CAP:
        logger.warning("nearby candidate cap reached for cell %s: result not cached", cell)
    else:
        nearby_cache.store(key, lots)
    return lots


def _within_radius(
    query: NearbyQuery, lots: list[NearbyLot], radius_m: int, now: datetime
) -> list[tuple[NearbyLot, float, bool]]:
    """(lot, distance from the REAL request point, is_open) nearest first, filtered."""
    measured = sorted(
        ((lot, haversine_m(query.lat, query.lng, lot.lat, lot.lng)) for lot in lots),
        key=lambda pair: (pair[1], pair[0].id),
    )
    rows = [
        (lot, distance, is_open_now(lot.open_time, lot.close_time, now))
        for lot, distance in measured
        if distance <= radius_m
    ]
    return [row for row in rows if row[2]] if query.only_open else rows


def _road_times(query: NearbyQuery, lots: list[NearbyLot]) -> list[float | None] | None:
    """OSRM Table seconds for each lot; None when OSRM is unavailable (fail-soft, logged
    without URL or message because those may carry credentials)."""
    if not lots:
        return None
    try:
        return osrm_client.table((query.lat, query.lng), [(lot.lat, lot.lng) for lot in lots])
    except osrm_client.OsrmError as exc:  # only routing failures are soft; bugs must surface
        logger.warning("osrm table failed: %s (%s)", type(exc).__name__, exc.reason)
        return None


def search_nearby(query: NearbyQuery, *, now: datetime | None = None) -> NearbySearchResult:
    """Two-stage nearby search: candidates by distance (KNN) -> road time (OSRM) -> ranking.

    The radius widens 1 -> 3 -> 5 -> 10 km while fewer than min(3, limit) lots qualify.
    """
    now = now or timezone.now()
    cell = geohash_encode(query.lat, query.lng, DEFAULT_GEOHASH_PRECISION)
    needed = min(MIN_RESULTS, query.limit)
    candidates: list[tuple[NearbyLot, float, bool]] = []
    radius_used = query.radius_m
    lots = _cell_candidates(query, cell)
    for radius_used in expansion_steps(query.radius_m):  # noqa: B007 - last value is reported
        candidates = _within_radius(query, lots, radius_used, now)
        if len(candidates) >= needed:
            break
    candidates = candidates[: CANDIDATE_FACTOR * query.limit]

    lots = [lot for lot, _, _ in candidates]
    distances = [distance for _, distance, _ in candidates]
    durations = _road_times(query, lots)
    scores = compute_scores(lots, metric=scoring_metric(distances, durations))
    results = [
        NearbyResult(
            lot=lot,
            distance_m=distance,
            duration_s=None if durations is None or durations[i] is None else round(durations[i]),
            score=scores[i],
            is_open=is_open,
        )
        for i, (lot, distance, is_open) in enumerate(candidates)
    ]
    return NearbySearchResult(
        results=sort_results(results, query.sort)[: query.limit], radius_used_m=radius_used
    )
