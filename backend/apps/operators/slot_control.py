"""Manual PHYSICAL slot status by the gate (PATCH /operator/slots/{id}).

Decisions (Step 9):

* An operator can only mark a slot ``FREE`` or ``OUT_OF_SERVICE``. ``OCCUPIED`` / ``RESERVED`` are
  never set by hand: they come from check-in and walk-in (the car's booking), so the slot state
  can never disagree with who is really parked there.
* A slot with a car in it (ACTIVE / OVERSTAY booking) cannot be changed at all: 409
  ``slot_in_use`` (check the car out first).
* Taking a slot out of service while live bookings still wait for it (CONFIRMED, or an unpaid
  hold that is still running) is refused with 409 ``slot_has_bookings`` unless ``force`` is set,
  and ``force`` is honoured only for OWNER / ADMIN (an OPERATOR gets 403 ``force_not_allowed``).
  A forced change leaves those bookings as they are: they will meet ``slot_out_of_service`` at
  the gate; the administrator sorts them out (Step 11). The count is audited.
* Lock order as everywhere: lot -> slot; the counters are recounted under the lot lock.
"""

from dataclasses import dataclass
from datetime import datetime

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.bookings import operations, services
from apps.bookings.conf import get_config
from apps.core.exceptions import Conflict, DomainPermissionDenied, NotFoundError
from apps.parking import access
from apps.parking.models import Slot, SlotStatus
from apps.parking.services import audit

from . import selectors


class SlotInUse(Conflict):
    default_detail = "A car is parked in this slot. Check it out first."
    default_code = "slot_in_use"


class SlotHasBookings(Conflict):
    default_detail = "Bookings are waiting for this slot."
    default_code = "slot_has_bookings"


class ForceNotAllowed(DomainPermissionDenied):
    default_detail = "Only an owner or an administrator may take a booked slot out of service."
    default_code = "force_not_allowed"


@dataclass(frozen=True)
class SlotChange:
    slot: Slot
    affected_bookings: int  # live bookings that wait for the slot (forced out of service only)


def set_slot_status(
    *, operator, slot_id, status: str, force: bool = False, now: datetime | None = None
) -> SlotChange:
    now = now or timezone.now()
    lot_id = Slot.objects.filter(pk=slot_id).values_list("zone__parking_lot_id", flat=True).first()
    if lot_id is None or access.get_operable_lot(operator, lot_id) is None:
        raise NotFoundError("Slot not found.")  # same answer for "no such slot" and "not yours"
    return _set_status_tx(
        operator=operator, lot_id=lot_id, slot_id=slot_id, status=status, force=force, now=now
    )


@services.retrying
@transaction.atomic
def _set_status_tx(*, operator, lot_id, slot_id, status, force, now) -> SlotChange:
    services.set_local_timeouts(get_config().lock_timeout_seconds)
    lot = services.lock_lot(lot_id)  # the lot first, always
    if not operations.still_operable(operator, lot):
        raise NotFoundError("Slot not found.")
    slot = services.lock_slot_wait(slot_id)
    if slot.status == status:
        return SlotChange(slot=slot, affected_bookings=0)
    if selectors.car_inside(slot.pk):
        raise SlotInUse
    waiting = selectors.waiting_bookings(slot.pk, now) if status == SlotStatus.OUT_OF_SERVICE else 0
    if waiting and not force:
        raise SlotHasBookings(f"{waiting} booking(s) are waiting for this slot.")
    if waiting and operator.role not in (User.Role.OWNER, User.Role.ADMIN):
        raise ForceNotAllowed
    before = slot.status
    operations.set_slot_status_locked(lot, slot, status)
    audit(
        actor=operator,
        action="operator.slot_status",
        obj_id=slot.pk,
        before={"status": before},
        after={"status": status, "force": bool(force), "affected_bookings": waiting},
    )
    return SlotChange(slot=slot, affected_bookings=waiting)
