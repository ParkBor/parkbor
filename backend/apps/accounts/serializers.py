from django.core.validators import RegexValidator
from rest_framework import serializers

from apps.accounts.models import Device, User

EXPO_TOKEN_VALIDATOR = RegexValidator(
    r"^(Expo|Exponent)PushToken\[[A-Za-z0-9_\-]+\]$", message="Invalid Expo push token."
)


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = (
            "id",
            "telegram_id",
            "telegram_username",
            "phone",
            "first_name",
            "last_name",
            "language",
            "role",
            "tg_notifications",
        )
        read_only_fields = fields


class ProfileUpdateSerializer(serializers.ModelSerializer):
    """Fields a user may edit about themselves (role/identity are never writable)."""

    class Meta:
        model = User
        fields = ("first_name", "last_name", "language", "tg_notifications")


class AuthResponseSerializer(serializers.Serializer):
    """JWT pair issued after a successful login."""

    access = serializers.CharField()
    refresh = serializers.CharField()
    user = UserSerializer()
    is_new = serializers.BooleanField()


class DeviceSerializer(serializers.ModelSerializer):
    # Uniqueness is handled by the service (a token moves between users), so no UniqueValidator.
    expo_push_token = serializers.CharField(max_length=200, validators=[EXPO_TOKEN_VALIDATOR])
    platform = serializers.ChoiceField(choices=Device.Platform.choices)

    class Meta:
        model = Device
        fields = ("id", "platform", "expo_push_token", "last_seen")
        read_only_fields = ("id", "last_seen")


class DeviceDeleteSerializer(serializers.Serializer):
    expo_push_token = serializers.CharField(max_length=200)


class LogoutSerializer(serializers.Serializer):
    refresh = serializers.CharField(max_length=2048)
    expo_push_token = serializers.CharField(
        max_length=200, required=False, validators=[EXPO_TOKEN_VALIDATOR]
    )
