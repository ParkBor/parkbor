"""Builders for the operator-gate tests (a lot with a staffed gate and a booked driver)."""

from datetime import timedelta
from types import SimpleNamespace

from django.utils import timezone

from apps.bookings import qr
from apps.bookings.state import BookingStatus
from apps.parking.models import OperatorAssignment
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user


def make_gate(slots=2, **world_kwargs):
    world = make_world(slots=slots, **world_kwargs)
    operator = make_user("OPERATOR")
    OperatorAssignment.objects.create(
        operator=operator, parking_lot=world.lot, created_by=world.owner
    )
    driver = make_user("DRIVER")
    return SimpleNamespace(
        world=world,
        lot=world.lot,
        owner=world.owner,
        zone=world.zone,
        slots=world.slots,
        slot=world.slots[0],
        operator=operator,
        driver=driver,
        vehicle=make_vehicle(driver),
        now=timezone.now().replace(second=0, microsecond=0),
    )


def book(gate, *, status=BookingStatus.CONFIRMED, start_min=-5, end_min=115, slot=None, **extra):
    """A booking starting `start_min` minutes from gate.now (negative = already started)."""
    return make_booking(
        user=extra.pop("user", gate.driver),
        slot=slot or gate.slot,
        vehicle=extra.pop("vehicle", gate.vehicle),
        start=gate.now + timedelta(minutes=start_min),
        end=gate.now + timedelta(minutes=end_min),
        status=status,
        **extra,
    )


def entry_token(booking) -> str:
    return qr.issue_token(booking)[0]


def exit_token(booking, now) -> str:
    return qr.issue_exit_token(booking, now=now)[0]
