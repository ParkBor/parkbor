"""Read queries of the operator side (assignments, invitations, gate lookups)."""

from datetime import datetime

from django.db.models import Q, QuerySet

from apps.bookings.conf import get_config
from apps.bookings.models import Booking
from apps.bookings.pricing import CENT, MINUTES_PER_HOUR
from apps.bookings.state import BookingStatus
from apps.parking.models import OperatorAssignment, OperatorInvite, ParkingLot, Tariff


def active_assignments(lot: ParkingLot) -> QuerySet[OperatorAssignment]:
    return OperatorAssignment.objects.filter(
        parking_lot=lot, revoked_at__isnull=True
    ).select_related("operator")


def open_invites(lot: ParkingLot, now: datetime) -> QuerySet[OperatorInvite]:
    """Invitations that can still be accepted (never exposes the code: only its hash exists)."""
    return OperatorInvite.objects.filter(
        parking_lot=lot, used_at__isnull=True, revoked_at__isnull=True, expires_at__gt=now
    )


def car_inside(slot_id) -> bool:
    """Is a car parked in this slot (an ACTIVE or OVERSTAY booking)?"""
    return Booking.objects.filter(
        slot_id=slot_id, status__in=(BookingStatus.ACTIVE, BookingStatus.OVERSTAY)
    ).exists()


def waiting_bookings(slot_id, now: datetime) -> int:
    """Live bookings that still wait for the slot: CONFIRMED, or an unpaid hold still running."""
    live = Q(status=BookingStatus.CONFIRMED) | Q(
        status=BookingStatus.PENDING_PAYMENT, hold_expires_at__gt=now
    )
    return Booking.objects.filter(live, slot_id=slot_id, ends_at__gt=now).count()


def tariff_for(lot_id, slot_type: str) -> Tariff | None:
    return Tariff.objects.filter(parking_lot_id=lot_id, slot_type=slot_type).first()


def next_action(booking: Booking) -> dict:
    """What the operator tells a driver who just entered: leave by the end; time after it costs
    one block per started ``BOOKING_ROUNDING_MINUTES`` (the base price: coefficients may raise
    it), taken in cash at the exit."""
    block = get_config().pricing.block_minutes
    tariff = tariff_for(booking.slot.zone.parking_lot_id, booking.slot.type)
    price = (
        None
        if tariff is None
        else (tariff.price_per_hour * block / MINUTES_PER_HOUR).quantize(CENT)
    )
    return {
        "checkout_by": booking.ends_at,
        "overstay": {
            "free_minutes": 0,  # nothing is free after the booking end
            "block_minutes": block,
            "price_per_block": price,
            "collected_at_exit": True,
        },
    }
