"""Account write operations: Telegram login, profile, devices, token lifecycle."""

from dataclasses import dataclass

from django.db import IntegrityError, transaction
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts import selectors
from apps.accounts.models import Device, User
from apps.core.exceptions import (
    AccountDisabledError,
    InvalidRefreshTokenError,
    PhoneTakenError,
)

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
    try:
        with transaction.atomic():
            user.save(update_fields=["phone", "telegram_username"])
    except IntegrityError:
        raise PhoneTakenError from None  # someone claimed the phone since the check above
    return LoginResult(user=user, is_new=False)


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
    """Attach the push token to the user (moving it from another user if needed)."""
    for attempt in (1, 2):
        try:
            with transaction.atomic():
                return Device.objects.update_or_create(
                    expo_push_token=expo_push_token, defaults={"user": user, "platform": platform}
                )
        except IntegrityError:
            # Concurrent insert of the same token; the retry takes the update path.
            if attempt == 2:
                raise
    raise AssertionError("unreachable")  # pragma: no cover


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
