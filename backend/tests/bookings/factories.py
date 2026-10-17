"""Builders for booking tests. Status is written through the sanctioned guard, like services."""

from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

from apps.bookings.fields import make_period
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus, status_write_allowed
from apps.parking.models import LotStatus, ParkingLot, Slot, SlotType, Tariff, Zone
from apps.vehicles.models import Vehicle
from tests.helpers import make_lot, make_user

_counter = {"vehicle": 0, "slot": 0}


class FakePgError(Exception):
    """Stands in for psycopg's error: Django chains it as ``__cause__`` of its own exception."""

    def __init__(self, sqlstate, constraint=None):
        super().__init__(sqlstate)
        self.sqlstate = sqlstate
        self.diag = SimpleNamespace(constraint_name=constraint)


def pg_integrity_error(constraint="booking_no_overlap", sqlstate="23P01"):
    """An IntegrityError that looks like psycopg's (cause carries sqlstate + constraint name)."""
    from django.db import IntegrityError

    error = IntegrityError(constraint)
    error.__cause__ = FakePgError(sqlstate, constraint)
    return error


def make_vehicle(user, vehicle_type="CAR", plate=None):
    _counter["vehicle"] += 1
    return Vehicle.objects.create(
        user=user, type=vehicle_type, plate_number=plate or f"01A{_counter['vehicle']:03d}BC"
    )


def make_slot(zone, slot_type=SlotType.STANDARD, distance=0, code=None, status="FREE"):
    _counter["slot"] += 1
    return Slot.objects.create(
        zone=zone,
        code=code or f"S-{_counter['slot']}",
        type=slot_type,
        distance_to_entrance=distance,
        status=status,
    )


def make_world(slots=1, slot_type=SlotType.STANDARD, price="6000", rules=None, **lot_extra):
    """An ACTIVE lot with one zone, `slots` slots of `slot_type` and a tariff for that type."""
    owner = make_user("OWNER")
    lot = make_lot(owner, status=LotStatus.ACTIVE, **lot_extra)
    zone = Zone.objects.create(parking_lot=lot, name="A", floor=1)
    created = [make_slot(zone, slot_type, distance=i) for i in range(slots)]
    tariff = Tariff.objects.create(
        parking_lot=lot, slot_type=slot_type, price_per_hour=Decimal(price), rules=rules or {}
    )
    ParkingLot.objects.filter(pk=lot.pk).update(total_slots=slots, free_slots=slots)
    lot.refresh_from_db()
    return SimpleNamespace(owner=owner, lot=lot, zone=zone, slots=created, tariff=tariff)


def make_booking(
    *,
    user,
    slot,
    vehicle,
    start: datetime,
    end: datetime,
    status=BookingStatus.PENDING_PAYMENT,
    amount="12000",
    paid_amount=None,
    hold_expires_at=None,
    **extra,
):
    if paid_amount is None:  # anything past the payment page was paid in full
        paid_amount = "0" if status == BookingStatus.PENDING_PAYMENT else amount
    with status_write_allowed():
        return Booking.objects.create(
            user=user,
            slot=slot,
            vehicle=vehicle,
            vehicle_plate=vehicle.plate_number,
            period=make_period(start, end),
            status=status,
            amount=Decimal(amount),
            paid_amount=Decimal(paid_amount),
            hold_expires_at=hold_expires_at,
            qr_nonce=extra.pop("qr_nonce", "n" * 22),
            **extra,
        )


def hours_from(now: datetime, start_h: float, end_h: float) -> tuple[datetime, datetime]:
    return now + timedelta(hours=start_h), now + timedelta(hours=end_h)
