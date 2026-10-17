from django.core.validators import RegexValidator
from rest_framework import serializers

LOGIN_TOKEN_VALIDATOR = RegexValidator(r"^[A-Za-z0-9_-]{16,64}$", message="Invalid login token.")


class StartLoginRequestSerializer(serializers.Serializer):
    # Stored with the session for diagnostics only; the flow does not bind to it (yet).
    device_id = serializers.CharField(max_length=128, required=False, allow_blank=True, default="")


class StartLoginResponseSerializer(serializers.Serializer):
    login_token = serializers.CharField()
    bot_url = serializers.URLField()
    expires_in = serializers.IntegerField()


class LoginStatusQuerySerializer(serializers.Serializer):
    login_token = serializers.CharField(max_length=64, validators=[LOGIN_TOKEN_VALIDATOR])


class LoginStatusResponseSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=["PENDING", "CONFIRMED", "EXPIRED"])
    needs_code = serializers.BooleanField()


class VerifyLoginRequestSerializer(serializers.Serializer):
    login_token = serializers.CharField(max_length=64, validators=[LOGIN_TOKEN_VALIDATOR])
    code = serializers.RegexField(r"^[0-9]{6}$", max_length=6, min_length=6)


class WidgetLoginRequestSerializer(serializers.Serializer):
    """Fields sent by the Telegram Login Widget; `hash` signs all the others."""

    id = serializers.IntegerField()
    # trim_whitespace=False: the HMAC is computed over the exact bytes Telegram signed.
    first_name = serializers.CharField(
        required=False, allow_blank=True, max_length=256, trim_whitespace=False
    )
    last_name = serializers.CharField(
        required=False, allow_blank=True, max_length=256, trim_whitespace=False
    )
    username = serializers.CharField(
        required=False, allow_blank=True, max_length=256, trim_whitespace=False
    )
    photo_url = serializers.CharField(
        required=False, allow_blank=True, max_length=1024, trim_whitespace=False
    )
    auth_date = serializers.IntegerField()
    hash = serializers.RegexField(r"^[0-9a-f]{64}$", max_length=64)


class WebhookUpdateSerializer(serializers.Serializer):
    """Telegram Update; only `update_id` is validated here, handlers read the rest defensively."""

    update_id = serializers.IntegerField()
