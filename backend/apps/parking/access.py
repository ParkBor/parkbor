"""Who may run a lot's gate functions (operator API; ARCHITECTURE 2, 6.3, 15).

One rule, used by the permission class, the selectors and the services:

* the lot must be ``ACTIVE`` (except for leaving / paying / reading: ``active_only=False``);
* ADMIN: any lot; OWNER: own lots; OPERATOR: lots with an active ``OperatorAssignment``;
* the user must be active (a disabled account loses access at once, JWT or not).

Everything else (driver, anonymous, foreign owner, revoked or demoted operator) gets ``None`` and
callers answer 404, so a lot id cannot be probed.
"""

from django.db.models import QuerySet
from rest_framework.permissions import BasePermission

from apps.accounts.models import User

from .models import LotStatus, OperatorAssignment, ParkingLot

_GATE_ROLES = (User.Role.OPERATOR, User.Role.OWNER, User.Role.ADMIN)


def _live(user) -> bool:
    return bool(
        user is not None
        and getattr(user, "is_authenticated", False)
        and getattr(user, "is_active", False)
        and getattr(user, "role", None) in _GATE_ROLES
    )


def has_active_assignment(user_id, lot_id) -> bool:
    return OperatorAssignment.objects.filter(
        operator_id=user_id, parking_lot_id=lot_id, revoked_at__isnull=True
    ).exists()


def operable_lots(user, *, active_only: bool = True) -> QuerySet[ParkingLot]:
    """Lots this user may operate (empty queryset for anyone else). ``active_only`` (default):
    only ACTIVE lots, as check-in, walk-in and slot changes need. Leaving, paying the overstay
    and reading the map stay possible in a lot that was suspended or sent back to review while
    cars are parked in it (``active_only=False``): nobody may be trapped inside."""
    lots = ParkingLot.objects.all()
    if active_only:
        lots = lots.filter(status=LotStatus.ACTIVE)
    if not _live(user):
        return lots.none()
    if user.role == User.Role.ADMIN:
        return lots
    if user.role == User.Role.OWNER:
        return lots.filter(owner_id=user.pk)
    assigned = OperatorAssignment.objects.filter(operator_id=user.pk, revoked_at__isnull=True)
    return lots.filter(pk__in=assigned.values("parking_lot_id"))


def get_operable_lot(user, lot_id, *, active_only: bool = True) -> ParkingLot | None:
    return operable_lots(user, active_only=active_only).filter(pk=lot_id).first()


class IsOperatorOfLot(BasePermission):
    """OPERATOR role; object-level: a lot (or something inside it) the operator is assigned to.
    Whether the lot must be ACTIVE depends on the action and is decided by the services (a
    suspended lot can still be read and left). Owners and admins pass through ``IsOwnerOfLot`` /
    ``IsSuperAdmin``."""

    def has_permission(self, request, view) -> bool:
        return _live(request.user) and request.user.role == User.Role.OPERATOR

    def has_object_permission(self, request, view, obj) -> bool:
        lot_id = lot_id_of(obj)
        return (
            _live(request.user)
            and request.user.role == User.Role.OPERATOR
            and lot_id is not None
            and operable_lots(request.user, active_only=False).filter(pk=lot_id).exists()
        )


def lot_id_of(obj):
    """Lot id of a lot / zone / slot / booking; None for anything else."""
    label = getattr(getattr(obj, "_meta", None), "label_lower", "")
    if label == "parking.parkinglot":
        return obj.pk
    if label == "parking.zone":
        return obj.parking_lot_id
    if label == "parking.slot":
        return obj.zone.parking_lot_id
    if label == "bookings.booking":
        return obj.slot.zone.parking_lot_id
    return None
