import uuid

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction

from apps.accounts.models import Device, User
from apps.core.logging_utils import mask_phone

pytestmark = pytest.mark.django_db


def test_auth_user_model_is_accounts_user():
    assert get_user_model() is User


def test_user_defaults():
    user = User.objects.create_user(telegram_id=1001)
    assert isinstance(user.id, uuid.UUID)
    assert user.role == User.Role.DRIVER
    assert user.language == "uz"
    assert user.tg_notifications is True
    assert user.is_active is True
    assert user.phone is None
    assert not user.has_usable_password()
    assert user.is_superuser is False


def test_username_field_is_telegram_id():
    assert User.USERNAME_FIELD == "telegram_id"


def test_roles_and_languages_match_spec():
    assert set(User.Role.values) == {"DRIVER", "OPERATOR", "OWNER", "ADMIN"}
    assert set(User.Language.values) == {"uz", "ru", "en"}


def test_telegram_id_is_unique():
    User.objects.create_user(telegram_id=1)
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.create_user(telegram_id=1)


def test_phone_is_unique_but_multiple_nulls_allowed():
    User.objects.create_user(telegram_id=1)
    User.objects.create_user(telegram_id=2)
    User.objects.create_user(telegram_id=3, phone="+998901111111")
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.create_user(telegram_id=4, phone="+998901111111")


def test_create_user_requires_telegram_id():
    with pytest.raises(ValueError):
        User.objects.create_user(telegram_id=None)


def test_create_superuser_is_admin_with_password():
    user = User.objects.create_superuser(telegram_id=9, password="a-long-secret-pass")
    assert user.is_superuser and user.role == User.Role.ADMIN
    assert user.check_password("a-long-secret-pass")


def test_create_superuser_requires_password():
    with pytest.raises(ValueError):
        User.objects.create_superuser(telegram_id=9, password=None)


def test_str_does_not_expose_phone():
    user = User.objects.create_user(telegram_id=5, phone="+998901234567")
    assert "998901234567" not in str(user)


def test_device_token_unique_and_cascade():
    user = User.objects.create_user(telegram_id=1)
    Device.objects.create(user=user, platform="android", expo_push_token="ExponentPushToken[a]")
    with pytest.raises(IntegrityError), transaction.atomic():
        Device.objects.create(user=user, platform="ios", expo_push_token="ExponentPushToken[a]")
    user.delete()
    assert Device.objects.count() == 0


def test_device_platform_choices():
    assert set(Device.Platform.values) == {"android", "ios"}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("+998901234567", "+998*******67"),
        ("998901234567", "9989******67"),
        ("12345", "*****"),
        ("", ""),
        (None, ""),
    ],
)
def test_mask_phone(raw, expected):
    assert mask_phone(raw) == expected
