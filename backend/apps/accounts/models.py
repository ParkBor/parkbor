from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models

from apps.core.models import BaseModel


class UserManager(BaseUserManager):
    def create_user(self, telegram_id: int | None, password: str | None = None, **extra):
        if telegram_id is None:
            raise ValueError("telegram_id is required")
        user = self.model(telegram_id=telegram_id, **extra)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save(using=self._db)
        return user

    def create_superuser(self, telegram_id: int, password: str | None = None, **extra):
        """Back-up super admin: the only account type that uses a password."""
        if not password:
            raise ValueError("A super admin requires a password")
        extra.setdefault("role", User.Role.ADMIN)
        extra["is_superuser"] = True
        return self.create_user(telegram_id, password, **extra)


class User(BaseModel, AbstractBaseUser, PermissionsMixin):
    """Telegram-based account. Passwords are unusable except for the back-up super admin."""

    class Role(models.TextChoices):
        DRIVER = "DRIVER"
        OPERATOR = "OPERATOR"
        OWNER = "OWNER"
        ADMIN = "ADMIN"

    class Language(models.TextChoices):
        UZ = "uz"
        RU = "ru"
        EN = "en"

    telegram_id = models.BigIntegerField(unique=True)
    telegram_username = models.CharField(max_length=64, blank=True)
    phone = models.CharField(max_length=16, unique=True, null=True, blank=True)  # noqa: DJ001
    first_name = models.CharField(max_length=150, blank=True)
    last_name = models.CharField(max_length=150, blank=True)
    language = models.CharField(max_length=2, choices=Language.choices, default=Language.UZ)
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.DRIVER)
    tg_notifications = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)

    objects = UserManager()

    USERNAME_FIELD = "telegram_id"
    REQUIRED_FIELDS: list[str] = []

    def __str__(self) -> str:
        return f"User(telegram_id={self.telegram_id}, role={self.role})"


class Device(BaseModel):
    """Expo push token of a user's device."""

    class Platform(models.TextChoices):
        ANDROID = "android"
        IOS = "ios"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="devices")
    platform = models.CharField(max_length=7, choices=Platform.choices)
    expo_push_token = models.CharField(max_length=200, unique=True)
    last_seen = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return f"Device({self.platform}, user={self.user_id})"
