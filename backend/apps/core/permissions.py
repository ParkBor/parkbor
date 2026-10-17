"""Role-based permission classes (ARCHITECTURE 15). Role lives on ``accounts.User.role``.

The real check is always here on the backend; the admin UI only hides buttons.
"""

from rest_framework.permissions import BasePermission

from apps.accounts.models import User

ROLE_ADMIN = User.Role.ADMIN
ROLE_OWNER = User.Role.OWNER
ROLE_OPERATOR = User.Role.OPERATOR
ROLE_DRIVER = User.Role.DRIVER

# Explicit model -> attribute path to the owning user id. Anything not listed is never trusted
# (a look-alike object with an `owner_id` attribute must not grant access).
OWNER_PATHS: dict[str, tuple[str, ...]] = {
    "parking.parkinglot": ("owner_id",),
    "parking.zone": ("parking_lot", "owner_id"),
    "parking.slot": ("zone", "parking_lot", "owner_id"),
    "parking.tariff": ("parking_lot", "owner_id"),
}


def _role(user) -> str | None:
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    if not getattr(user, "is_active", True):
        return None
    return getattr(user, "role", None)


def is_super_admin(user) -> bool:
    return _role(user) == ROLE_ADMIN


def is_owner(user) -> bool:
    return _role(user) == ROLE_OWNER


def lot_owner_id(obj):
    """Owning user id of a lot / zone / slot / tariff (None for anything else)."""
    meta = getattr(obj, "_meta", None)
    path = OWNER_PATHS.get(getattr(meta, "label_lower", ""))
    if path is None:
        return None
    current = obj
    for attr in path:
        current = getattr(current, attr, None)
        if current is None:
            return None
    return current


class IsSuperAdmin(BasePermission):
    """ADMIN role: unrestricted access."""

    def has_permission(self, request, view) -> bool:
        return is_super_admin(request.user)

    def has_object_permission(self, request, view, obj) -> bool:
        return is_super_admin(request.user)


class IsOwnerOfLot(BasePermission):
    """OWNER role; object-level: only objects belonging to the owner's own parking lot."""

    def has_permission(self, request, view) -> bool:
        return is_owner(request.user)

    def has_object_permission(self, request, view, obj) -> bool:
        if not is_owner(request.user):
            return False
        owner_id = lot_owner_id(obj)
        return owner_id is not None and owner_id == request.user.pk


class IsRecordOwner(BasePermission):
    """Any authenticated active user for the view; object-level: ``obj.user_id`` is the caller.

    For personal records (vehicles, bookings). Querysets are ALSO scoped to the caller, so a
    foreign id answers 404 and this check is the second line of defence.
    """

    def has_permission(self, request, view) -> bool:
        return _role(request.user) is not None

    def has_object_permission(self, request, view, obj) -> bool:
        return _role(request.user) is not None and getattr(obj, "user_id", None) == request.user.pk
