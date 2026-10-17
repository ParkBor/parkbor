"""Read queries for bookings. Overlap logic uses the scalar ``starts_at``/``ends_at`` columns, so
it is identical on PostgreSQL and SQLite; the EXCLUDE constraint remains the hard guarantee."""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from django.db.models import Exists, Min, OuterRef, Q, QuerySet

from apps.parking.models import Slot, SlotStatus

from .allocation import GAP_LOOKBACK, SlotCandidate
from .models import Booking, BookingEvent
from .state import BLOCKING_STATUSES, SCOPE_STATUSES, BookingStatus

# Counted against BOOKING_MAX_ACTIVE: everything that still holds or will use a slot.
LIVE_FOR_LIMIT = (BookingStatus.PENDING_PAYMENT, BookingStatus.CONFIRMED, BookingStatus.ACTIVE)


def bookings_for_user(user) -> QuerySet[Booking]:
    return (
        Booking.objects.filter(user=user)
        .select_related("slot__zone__parking_lot", "vehicle")
        .prefetch_related("refunds")
    )


def filter_bookings(
    queryset: QuerySet[Booking], *, statuses: list[str] | None, scope: str | None
) -> QuerySet[Booking]:
    """`?status=` (any of) intersected with `?scope=`; ordered for the chosen view."""
    if scope:
        queryset = queryset.filter(status__in=SCOPE_STATUSES[scope])
    if statuses:
        queryset = queryset.filter(status__in=statuses)
    if scope == "active":
        return queryset.order_by("ends_at", "id")
    if scope == "upcoming":
        return queryset.order_by("starts_at", "id")
    return queryset.order_by("-starts_at", "id")


def get_user_booking(user, booking_id) -> Booking | None:
    return bookings_for_user(user).filter(pk=booking_id).first()


def lot_id_of_booking(booking_id, user=None):
    """Lot id owning the booking's slot (None if the booking does not exist / is not the user's)."""
    queryset = Booking.objects.filter(pk=booking_id)
    if user is not None:
        queryset = queryset.filter(user=user)
    return queryset.values_list("slot__zone__parking_lot_id", flat=True).first()


def blocks(start: datetime, end: datetime) -> Q:
    """Bookings that occupy ``[start, end)``: live ones whose period overlaps it, and ANY
    OVERSTAY booking that began before ``end``. An overstaying car is still physically in the
    slot after its period ended, so the slot (and the car) stay taken until check-out. The EXCLUDE
    constraints cannot express that (the range has ended), so the service enforces it under
    the lot lock."""
    return Q(status__in=BLOCKING_STATUSES, starts_at__lt=end, ends_at__gt=start) | Q(
        status=BookingStatus.OVERSTAY, starts_at__lt=end
    )


def slot_has_overlap(slot_id, start: datetime, end: datetime, *, exclude_booking_id=None) -> bool:
    """Does a live booking on `slot_id` overlap ``[start, end)`` (half-open)?"""
    queryset = Booking.objects.filter(blocks(start, end), slot_id=slot_id)
    if exclude_booking_id is not None:
        queryset = queryset.exclude(pk=exclude_booking_id)
    return queryset.exists()


def vehicle_has_overlap(
    plate: str, start: datetime, end: datetime, *, now: datetime, exclude_booking_id=None
) -> bool:
    """Does a live booking of this CAR (identified by its recorded plate, whoever booked it and
    in whichever lot) overlap ``[start, end)``? Unpaid holds that already ran out are ignored:
    they are about to be expired and must not make the car "busy"."""
    queryset = Booking.objects.filter(blocks(start, end), vehicle_plate=plate).exclude(
        status=BookingStatus.PENDING_PAYMENT, hold_expires_at__lte=now
    )
    if exclude_booking_id is not None:
        queryset = queryset.exclude(pk=exclude_booking_id)
    return queryset.exists()


def user_booking_counts(user, now: datetime) -> tuple[int, int]:
    """(unpaid holds, live bookings that have not ended yet) of a user."""
    live = Booking.objects.filter(user=user, status__in=LIVE_FOR_LIMIT, ends_at__gt=now)
    return (
        live.filter(status=BookingStatus.PENDING_PAYMENT).count(),
        live.count(),
    )


def abandoned_holds(user, since: datetime) -> int:
    """Unpaid holds this user let go (cancelled or expired) since `since`."""
    return BookingEvent.objects.filter(
        booking__user=user,
        from_status=BookingStatus.PENDING_PAYMENT,
        to_status__in=(BookingStatus.CANCELLED, BookingStatus.EXPIRED),
        created_at__gte=since,
    ).count()


def overdue_holds_in_lot(lot_id, now: datetime, limit: int):
    """Ids of unpaid bookings in a lot whose hold has run out (they must not block anyone)."""
    return list(
        Booking.objects.filter(
            slot__zone__parking_lot_id=lot_id,
            status=BookingStatus.PENDING_PAYMENT,
            hold_expires_at__lte=now,
        )
        .order_by("hold_expires_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


def _working_slots(lot_id, slot_type: str | None) -> QuerySet[Slot]:
    working = Slot.objects.filter(zone__parking_lot_id=lot_id).exclude(
        status=SlotStatus.OUT_OF_SERVICE
    )
    return working if slot_type is None else working.filter(type=slot_type)


def count_availability(
    lot_id,
    slot_type: str | None,
    start: datetime,
    end: datetime,
    *,
    now: datetime,
    immediate_window,
) -> tuple[int, int]:
    """(working slots, slots free for ``[start, end)``) with two COUNT queries: the quote and
    availability endpoints must not load every slot and booking row of a big lot per request.
    Same rule as ``build_pool`` (tests assert they agree)."""
    working = _working_slots(lot_id, slot_type)
    overlapping = Booking.objects.filter(blocks(start, end), slot_id=OuterRef("pk"))
    free = working.exclude(Exists(overlapping))
    if start <= now + immediate_window:
        free = free.exclude(status__in=(SlotStatus.OCCUPIED, SlotStatus.RESERVED))
    return working.count(), free.count()


@dataclass(frozen=True)
class SlotPool:
    """Who can take ``[start, end)`` in a lot, computed from one consistent read."""

    candidates: list[SlotCandidate]
    total: int  # working slots (not OUT_OF_SERVICE) of the requested type
    previous_ends: dict[uuid.UUID, datetime] = field(default_factory=dict)

    @property
    def available(self) -> int:
        return len(self.candidates)

    @property
    def occupancy(self) -> Decimal:
        """Share of working slots that cannot take the period (0 when the lot has none)."""
        if self.total == 0:
            return Decimal(0)
        return Decimal(self.total - self.available) / Decimal(self.total)


def build_pool(
    lot_id,
    slot_type: str | None,
    start: datetime,
    end: datetime,
    *,
    now: datetime,
    immediate_window,
    exclude_booking_id=None,
) -> SlotPool:
    """Free slots for ``[start, end)`` per ARCHITECTURE 10.3.

    free = working slots of the type - slots with a live overlapping booking; additionally, when
    the period starts within `immediate_window` of `now`, slots that are physically
    OCCUPIED/RESERVED right now (walk-ins have no end time).
    """
    working = _working_slots(lot_id, slot_type)
    slots = list(working.values("id", "code", "distance_to_entrance", "status"))

    rows = Booking.objects.filter(
        blocks(start - GAP_LOOKBACK, end), slot__zone__parking_lot_id=lot_id
    )  # the wider window also yields the previous bookings used for best-fit
    if exclude_booking_id is not None:
        rows = rows.exclude(pk=exclude_booking_id)
    busy: set[uuid.UUID] = set()
    previous_ends: dict[uuid.UUID, datetime] = {}
    for slot_id, status, starts_at, ends_at in rows.values_list(
        "slot_id", "status", "starts_at", "ends_at"
    ):
        if status == BookingStatus.OVERSTAY or (starts_at < end and ends_at > start):
            busy.add(slot_id)
        elif ends_at <= start and ends_at > previous_ends.get(slot_id, ends_at - GAP_LOOKBACK):
            previous_ends[slot_id] = ends_at

    physically_blocked = start <= now + immediate_window
    candidates = [
        SlotCandidate(id=s["id"], distance_to_entrance=s["distance_to_entrance"], code=s["code"])
        for s in slots
        if s["id"] not in busy
        and not (physically_blocked and s["status"] in (SlotStatus.OCCUPIED, SlotStatus.RESERVED))
    ]
    return SlotPool(candidates=candidates, total=len(slots), previous_ends=previous_ends)


def next_live_start(
    *, slot_id=None, plate: str | None = None, after: datetime, before: datetime, now: datetime
) -> datetime | None:
    """Earliest start in ``[after, before)`` of a live booking on the slot / of the plate (unpaid
    holds that already ran out are ignored). Used to cut a walk-in short in front of it."""
    queryset = Booking.objects.filter(
        status__in=BLOCKING_STATUSES, starts_at__gte=after, starts_at__lt=before
    ).exclude(status=BookingStatus.PENDING_PAYMENT, hold_expires_at__lte=now)
    if slot_id is not None:
        queryset = queryset.filter(slot_id=slot_id)
    if plate is not None:
        queryset = queryset.filter(vehicle_plate=plate)
    return queryset.aggregate(first=Min("starts_at"))["first"]
