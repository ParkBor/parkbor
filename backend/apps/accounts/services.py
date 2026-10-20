"""Account write operations: Telegram login, profile, devices, token lifecycle."""

import logging
import uuid
from dataclasses import dataclass

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts import selectors
from apps.accounts.models import Device, User
from apps.core.exceptions import (
    AccountDisabledError,
    Conflict,
    InvalidRefreshTokenError,
    PhoneTakenError,
)

logger = logging.getLogger(__name__)

PROFILE_FIELDS = ("first_name", "last_name", "language", "tg_notifications")


@dataclass(frozen=True)
class LoginResult:
    user: User
    is_new: bool


def login_with_telegram(
    *, telegram_id: int, phone: str, username: str, first_name: str, last_name: str
) -> LoginResult:
    """Find the account by telegram_id (or create it) and refresh phone/username from Telegram."""
    if selectors.phone_belongs_to_other_user(phone, telegram_id):
        raise PhoneTakenError
    user = selectors.get_user_by_telegram_id(telegram_id)
    if user is None:
        return _create_user(telegram_id, phone, username, first_name, last_name)
    if not user.is_active:
        raise AccountDisabledError
    user.phone = phone
    user.telegram_username = username
    fill_missing_names(user, first_name, last_name)
    try:
        with transaction.atomic():
            user.save(update_fields=["phone", "telegram_username", "first_name", "last_name"])
    except IntegrityError:
        raise PhoneTakenError from None  # someone claimed the phone since the check above
    return LoginResult(user=user, is_new=False)


def fill_missing_names(user: User, first_name: str, last_name: str) -> None:
    """A pre-created account (an administrator named this Telegram id as a lot owner) has no name
    yet: the first login fills it. A name the person already has is never overwritten."""
    user.first_name = user.first_name or first_name or ""
    user.last_name = user.last_name or last_name or ""


def _create_user(telegram_id, phone, username, first_name, last_name) -> LoginResult:
    try:
        with transaction.atomic():
            user = User.objects.create_user(
                telegram_id=telegram_id,
                phone=phone,
                telegram_username=username,
                first_name=first_name,
                last_name=last_name,
            )
    except IntegrityError:
        # Concurrent login created it first, or the phone was taken in the meantime.
        existing = selectors.get_user_by_telegram_id(telegram_id)
        if existing is None:
            raise PhoneTakenError from None
        return LoginResult(user=existing, is_new=False)
    return LoginResult(user=user, is_new=True)


def require_active(user: User) -> User:
    if not user.is_active:
        raise AccountDisabledError
    return user


def issue_tokens(user: User) -> dict[str, str]:
    refresh = RefreshToken.for_user(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


def revoke_refresh_token(user: User, raw_refresh: str) -> None:
    """Blacklist the user's own refresh token; anything else is reported as invalid."""
    try:
        token = RefreshToken(raw_refresh)
        if str(token.get("user_id")) != str(user.pk):
            raise TokenError("token belongs to another user")
        token.blacklist()
    except TokenError:
        raise InvalidRefreshTokenError from None


def update_profile(user: User, changes: dict) -> User:
    fields = [f for f in PROFILE_FIELDS if f in changes]
    for field in fields:
        setattr(user, field, changes[field])
    if fields:
        user.save(update_fields=fields)
    return user


def register_device(user: User, *, platform: str, expo_push_token: str) -> tuple[Device, bool]:
    """Attach the push token to the user (moving it from another user if needed).

    A user keeps at most ``DEVICES_MAX_PER_USER`` devices: registering one more drops the least
    recently seen (stale installs must not make every notification fan out to dozens of tokens).
    A token that moves between accounts is logged (a shared or resold phone, or abuse)."""
    for attempt in (1, 2):
        try:
            with transaction.atomic():
                owner_id = (
                    Device.objects.filter(expo_push_token=expo_push_token)
                    .values_list("user_id", flat=True)
                    .first()
                )
                if owner_id is not None and owner_id != user.pk:
                    logger.warning("push token moved from user %s to user %s", owner_id, user.pk)
                result = Device.objects.update_or_create(
                    expo_push_token=expo_push_token, defaults={"user": user, "platform": platform}
                )
                _trim_devices(user)
                return result
        except IntegrityError:
            # Concurrent insert of the same token; the retry takes the update path.
            if attempt == 2:
                raise
    raise AssertionError("unreachable")  # pragma: no cover


def _trim_devices(user: User) -> None:
    keep = settings.DEVICES_MAX_PER_USER
    surplus = list(
        Device.objects.filter(user=user)
        .order_by("-last_seen", "-created_at", "id")
        .values_list("pk", flat=True)[keep:]
    )
    if surplus:
        Device.objects.filter(pk__in=surplus).delete()


def logout(user: User, raw_refresh: str, expo_push_token: str | None = None) -> None:
    """Revoke the refresh token and, if given, unregister this device's push token.

    Only the device that logs out is unregistered (not all of the user's devices), so other
    signed-in devices keep receiving notifications.
    """
    revoke_refresh_token(user, raw_refresh)
    if expo_push_token:
        remove_device(user, expo_push_token)


def remove_device(user: User, expo_push_token: str) -> None:
    Device.objects.filter(user=user, expo_push_token=expo_push_token).delete()


# --- account deletion (DELETE /me) ---------------------------------------------------------------

BLOCKING_BOOKING_STATUSES = ("PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "OVERSTAY")
_TOMBSTONE_BITS = 62


class AccountDeletionBlocked(Conflict):
    default_detail = "Finish or cancel your bookings (and hand over your parking lots) first."
    default_code = "account_deletion_blocked"


def _deletion_blocker(user: User) -> bool:
    """True when the account may not go away yet: live bookings, own parking lots, or it is the
    last active administrator."""
    from apps.bookings.models import Booking
    from apps.parking.models import ParkingLot

    if Booking.objects.filter(user=user, status__in=BLOCKING_BOOKING_STATUSES).exists():
        return True
    if ParkingLot.objects.filter(owner=user).exists():
        return True
    return (
        user.role == User.Role.ADMIN
        and not User.objects.filter(role=User.Role.ADMIN, is_active=True)
        .exclude(pk=user.pk)
        .exists()
    )


def _tombstone_telegram_id() -> int:
    """A NEGATIVE number (real Telegram ids are positive) that frees the real id: the same person
    can sign up again later as a brand-new account."""
    while True:
        candidate = -(uuid.uuid4().int >> (128 - _TOMBSTONE_BITS)) - 1
        if not User.objects.filter(telegram_id=candidate).exists():
            return candidate


@transaction.atomic
def delete_account(user: User) -> None:
    """Anonymise (never hard-delete: bookings and payments stay for accounting) and sign out.

    Name, username and phone are cleared, the Telegram id becomes a tombstone, the account is
    blocked, push tokens go, refresh tokens are blacklisted, operator assignments end. Open
    WebSockets close at their next account re-check (``is_active``)."""
    from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

    from apps.parking.models import OperatorAssignment
    from apps.parking.services import audit

    locked = User.objects.select_for_update().get(pk=user.pk)
    if _deletion_blocker(locked):
        raise AccountDeletionBlocked
    role = locked.role
    locked.first_name = locked.last_name = locked.telegram_username = ""
    locked.phone = None
    locked.telegram_id = _tombstone_telegram_id()
    locked.is_active = False
    locked.set_unusable_password()
    locked.save(
        update_fields=[
            "first_name", "last_name", "telegram_username", "phone", "telegram_id", "is_active",
            "password",
        ]
    )  # fmt: skip
    Device.objects.filter(user=locked).delete()
    OperatorAssignment.objects.filter(operator=locked, revoked_at__isnull=True).update(
        revoked_at=timezone.now(), revoked_by=locked
    )
    pending = OutstandingToken.objects.filter(user=locked, blacklistedtoken__isnull=True)
    BlacklistedToken.objects.bulk_create(
        [BlacklistedToken(token=token) for token in pending], ignore_conflicts=True
    )
    audit(
        actor=locked,
        action="user.self_deleted",
        obj_id=locked.pk,
        before={"role": role, "is_active": True},
        after={"is_active": False},
    )
