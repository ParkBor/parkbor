"""The operator's slot map (GET /operator/parkings/{id}/slots).

Two queries however big the lot is (slots with their zone; the lot's relevant bookings), put
together in Python: no query per slot. PII-minimal by construction: only the booking id, status,
kind, plate and times are selected: never a user, name or phone.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from django.conf import settings
from django.db.models import Q

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus
from apps.parking.models import ParkingLot, Slot

_INSIDE = (BookingStatus.ACTIVE, BookingStatus.OVERSTAY)
_BOOKING_COLUMNS = ("id", "slot_id", "status", "kind", "vehicle_plate", "starts_at", "ends_at")


@dataclass(frozen=True)
class MapBooking:
    id: object
    status: str
    kind: str
    plate_number: str | None
    start: datetime
    end: datetime


@dataclass(frozen=True)
class MapSlot:
    slot: Slot
    current: MapBooking | None  # the car that is parked there now (ACTIVE / OVERSTAY)
    next: MapBooking | None  # the next CONFIRMED booking that has not arrived yet


def _booking(row: dict, show_plate: bool = True) -> MapBooking:
    return MapBooking(
        id=row["id"],
        status=row["status"],
        kind=row["kind"],
        plate_number=row["vehicle_plate"] if show_plate else None,
        start=row["starts_at"],
        end=row["ends_at"],
    )


def _relevant_bookings(lot: ParkingLot, now: datetime):
    horizon = now + timedelta(hours=settings.OPERATOR_MAP_HORIZON_HOURS)
    parked = Q(status__in=_INSIDE)
    waiting = Q(status=BookingStatus.CONFIRMED, ends_at__gt=now, starts_at__lt=horizon)
    return (
        Booking.objects.filter(parked | waiting, slot__zone__parking_lot=lot)
        .order_by("starts_at", "id")
        .values(*_BOOKING_COLUMNS)
    )


def slot_map(lot: ParkingLot, now: datetime) -> tuple[list[MapSlot], bool]:
    """(slots, truncated). At most ``OPERATOR_MAP_MAX_SLOTS`` slots are returned."""
    limit = settings.OPERATOR_MAP_MAX_SLOTS
    slots = list(
        Slot.objects.filter(zone__parking_lot=lot)
        .select_related("zone")
        .order_by("zone__floor", "zone__name", "code", "id")[: limit + 1]
    )
    truncated = len(slots) > limit
    slots = slots[:limit]
    plate_until = now + timedelta(hours=settings.OPERATOR_MAP_PLATE_HOURS)
    current: dict = {}
    upcoming: dict = {}
    for row in _relevant_bookings(lot, now):
        if row["status"] in _INSIDE:
            current.setdefault(row["slot_id"], _booking(row))
        else:
            # ordered by start: the first wins; a far-away booking keeps its plate hidden
            upcoming.setdefault(row["slot_id"], _booking(row, row["starts_at"] <= plate_until))
    return [MapSlot(s, current.get(s.pk), upcoming.get(s.pk)) for s in slots], truncated
