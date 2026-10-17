"""Vehicle writes. Views stay thin; rules and transactions live here."""

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction

from apps.bookings.state import BLOCKING_STATUSES
from apps.core.exceptions import Conflict, UnprocessableError

from .models import Vehicle


class VehicleLimitReached(UnprocessableError):
    default_detail = "Too many vehicles; remove one before adding another."
    default_code = "vehicle_limit_reached"


class VehicleExists(Conflict):
    default_detail = "You already have a vehicle with this plate number."
    default_code = "vehicle_exists"


class VehicleInUse(Conflict):
    default_detail = "This vehicle has a live booking."
    default_code = "vehicle_in_use"


def _has_live_booking(vehicle: Vehicle) -> bool:
    return vehicle.bookings.filter(status__in=BLOCKING_STATUSES).exists()


@transaction.atomic
def create_vehicle(*, user, data: dict) -> Vehicle:
    # Lock the owner row so two parallel creates cannot both slip under the soft limit.
    get_user_model().objects.select_for_update(no_key=True).get(pk=user.pk)
    if (
        Vehicle.objects.filter(user=user, is_archived=False).count()
        >= settings.VEHICLES_MAX_PER_USER
    ):
        raise VehicleLimitReached
    try:
        with transaction.atomic():
            return Vehicle.objects.create(user=user, **data)
    except IntegrityError as exc:
        raise VehicleExists from exc


@transaction.atomic
def update_vehicle(*, vehicle: Vehicle, data: dict) -> Vehicle:
    """Change plate/type. Refused while a live booking uses the vehicle (its slot type was
    checked against the old type). Past bookings keep the plate they were made with."""
    current = Vehicle.objects.select_for_update(no_key=True).get(pk=vehicle.pk)
    changed = {k: v for k, v in data.items() if getattr(current, k) != v}
    if not changed:
        return current
    if _has_live_booking(current):
        raise VehicleInUse("This vehicle has an active booking and cannot be changed now.")
    for field, value in changed.items():
        setattr(current, field, value)
    try:
        with transaction.atomic():
            current.save(update_fields=list(changed))
    except IntegrityError as exc:
        raise VehicleExists from exc
    return current


@transaction.atomic
def delete_vehicle(*, vehicle: Vehicle) -> None:
    """Remove a vehicle: really deleted when it never had a booking, otherwise archived (soft
    delete) so history stays intact. Archived vehicles do not count towards the limit and free
    their plate number. A live booking blocks both."""
    current = Vehicle.objects.select_for_update(no_key=True).get(pk=vehicle.pk)
    if _has_live_booking(current):
        raise VehicleInUse("This vehicle has an active booking and cannot be removed now.")
    if current.bookings.exists():
        current.is_archived = True
        current.save(update_fields=["is_archived"])
    else:
        current.delete()
