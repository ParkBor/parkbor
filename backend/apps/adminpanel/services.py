"""Admin write operations that belong to no other app: user management and booking settings.

Every mutation runs in ONE transaction together with its ``AuditLog`` row (``parking.services.
audit`` writes it inside the caller's transaction), so a change without a record is impossible.
"""

import logging

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from apps.accounts.models import User
from apps.bookings import conf
from apps.bookings import services as booking_services
from apps.bookings.models import BookingSetting
from apps.core.exceptions import (
    Conflict,
    DomainPermissionDenied,
    DomainValidationError,
    NotFoundError,
)
from apps.parking.models import OperatorAssignment, ParkingLot
from apps.parking.services import audit

logger = logging.getLogger(__name__)

ADMIN = User.Role.ADMIN
OWNER = User.Role.OWNER
OPERATOR = User.Role.OPERATOR


class SelfModification(DomainPermissionDenied):
    default_detail = "You cannot change your own account."
    default_code = "cannot_modify_self"


class SuperAdminProtected(DomainPermissionDenied):
    default_detail = "The super administrator cannot be changed here."
    default_code = "super_admin_protected"


class SuperAdminRequired(DomainPermissionDenied):
    default_detail = "Only the super administrator may grant, remove or block the ADMIN role."
    default_code = "super_admin_required"


class LastAdmin(Conflict):
    default_detail = "At least one active administrator must remain."
    default_code = "last_admin"


class OwnerHasParkings(Conflict):
    default_detail = "This owner still has parking lots; reassign or remove them first."
    default_code = "owner_has_parkings"


# --- users ---------------------------------------------------------------------------------------


def revoke_refresh_tokens(user: User) -> int:
    """Blacklist every refresh token of the account (no new access tokens can be minted)."""
    pending = OutstandingToken.objects.filter(user=user, blacklistedtoken__isnull=True)
    rows = [BlacklistedToken(token=token) for token in pending]
    BlacklistedToken.objects.bulk_create(rows, ignore_conflicts=True)
    return len(rows)


def _check_actor_may_touch(actor: User, target: User, new_role: str | None) -> None:
    if target.pk == actor.pk:
        raise SelfModification
    if target.is_superuser:
        raise SuperAdminProtected
    touches_admin = target.role == ADMIN or new_role == ADMIN
    if touches_admin and not actor.is_superuser:
        raise SuperAdminRequired


def _active_admins_left(excluding: User) -> bool:
    return User.objects.filter(role=ADMIN, is_active=True).exclude(pk=excluding.pk).exists()


def _end_operator_assignments(user: User, actor: User) -> None:
    OperatorAssignment.objects.filter(operator=user, revoked_at__isnull=True).update(
        revoked_at=timezone.now(), revoked_by=actor
    )


def _change_role(target: User, new_role: str, actor: User) -> None:
    old_role = target.role
    if old_role == ADMIN and not _active_admins_left(target):
        raise LastAdmin
    if old_role == OWNER and ParkingLot.objects.filter(owner=target).exists():
        raise OwnerHasParkings
    if old_role == OPERATOR:
        _end_operator_assignments(target, actor)
    target.role = new_role
    target.save(update_fields=["role"])
    audit(
        actor=actor,
        action="user.role_change",
        obj_id=target.pk,
        before={"role": old_role},
        after={"role": new_role, "user": str(target.pk)},
    )


def _change_active(target: User, is_active: bool, actor: User) -> None:
    if not is_active and target.role == ADMIN and not _active_admins_left(target):
        raise LastAdmin
    target.is_active = is_active
    target.save(update_fields=["is_active"])
    if not is_active:
        revoke_refresh_tokens(target)  # the access token dies with is_active; WS revalidates
    audit(
        actor=actor,
        action="user.unblock" if is_active else "user.block",
        obj_id=target.pk,
        before={"is_active": not is_active},
        after={"is_active": is_active, "user": str(target.pk)},
    )


@booking_services.retrying
@transaction.atomic
def update_user(*, actor: User, user_id, role: str | None = None, is_active: bool | None = None):
    """Change the role and/or the blocked state of an account (ADMIN only).

    Refused: acting on yourself, on the super administrator, granting / removing / blocking ADMIN
    unless the actor is the super administrator, and anything that would leave no active ADMIN.
    Blocking blacklists the account's refresh tokens (access tokens stop working at once because
    JWT authentication refuses inactive accounts; open WebSockets re-check the account).
    A no-op change writes nothing."""
    if role is not None and role not in User.Role.values:
        raise DomainValidationError("Unknown role.")
    booking_services.set_local_timeouts(5)
    target = User.objects.select_for_update().filter(pk=user_id).first()
    if target is None:
        raise NotFoundError("User not found.")
    _check_actor_may_touch(actor, target, role)
    if role is not None and role != target.role:
        _change_role(target, role, actor)
    if is_active is not None and is_active != target.is_active:
        _change_active(target, is_active, actor)
    return target


# --- booking settings ---------------------------------------------------------------------------


def validate_settings(values: dict[str, int]) -> None:
    """Ranges and cross-field rules over the COMPLETE set of values."""
    for key, (_, low, high) in conf.EDITABLE_SETTINGS.items():
        value = values[key]
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise DomainValidationError(f"{key} must be an integer from {low} to {high}.")
    if values["cancel_late_percent"] > values["cancel_full_percent"]:
        raise DomainValidationError("cancel_late_percent must not exceed cancel_full_percent.")
    if values["cancel_after_start_percent"] > values["cancel_late_percent"]:
        raise DomainValidationError(
            "cancel_after_start_percent must not exceed cancel_late_percent."
        )


def _current_values() -> dict[str, int]:
    """Effective values read from the database (never the cache: this runs under the lock)."""
    rows = dict(BookingSetting.objects.select_for_update().values_list("key", "value"))
    return {
        key: rows.get(key, getattr(settings, name))
        for key, (name, _, _) in conf.EDITABLE_SETTINGS.items()
    }


@booking_services.retrying
@transaction.atomic
def update_settings(*, actor: User, changes: dict[str, int]) -> dict[str, int]:
    """Apply a partial update of the admin-editable booking settings; returns all values."""
    unknown = sorted(set(changes) - set(conf.EDITABLE_SETTINGS))
    if unknown:
        raise DomainValidationError(f"Unknown setting: {', '.join(unknown)}.")
    current = _current_values()
    merged = {**current, **changes}
    validate_settings(merged)
    changed = {key: value for key, value in changes.items() if current[key] != value}
    for key, value in changed.items():
        BookingSetting.objects.update_or_create(
            key=key, defaults={"value": value, "updated_by": actor}
        )
    if changed:
        audit(
            actor=actor,
            action="settings.update",
            obj_id="booking_policy",
            before={key: current[key] for key in changed},
            after=dict(changed),
        )
        cache.delete(conf.OVERRIDES_CACHE_KEY)
        transaction.on_commit(lambda: cache.delete(conf.OVERRIDES_CACHE_KEY))
        logger.info("booking settings changed: %s", ", ".join(sorted(changed)))
    return merged
