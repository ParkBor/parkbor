from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts import services as account_services
from apps.accounts.serializers import AuthResponseSerializer, UserSerializer
from apps.core.exceptions import InvalidWebhookSecretError
from apps.core.serializers import ErrorSerializer
from apps.telegram_bot import login_service, services, webhook
from apps.telegram_bot.serializers import (
    LoginStatusQuerySerializer,
    LoginStatusResponseSerializer,
    StartLoginRequestSerializer,
    StartLoginResponseSerializer,
    VerifyLoginRequestSerializer,
    WebhookUpdateSerializer,
    WidgetLoginRequestSerializer,
)
from apps.telegram_bot.throttling import TelegramAuthThrottle, TelegramStatusThrottle

_THROTTLED = OpenApiResponse(description="Too many requests (10 per minute per IP).")


class PublicAuthView(APIView):
    """Login endpoints: no credentials needed (and a stale Authorization header is ignored)."""

    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_classes = [TelegramAuthThrottle]


def _auth_response(result: account_services.LoginResult) -> Response:
    tokens = account_services.issue_tokens(result.user)
    return Response({**tokens, "user": UserSerializer(result.user).data, "is_new": result.is_new})


class StartLoginView(PublicAuthView):
    @extend_schema(
        operation_id="auth_telegram_start",
        request=StartLoginRequestSerializer,
        responses={200: StartLoginResponseSerializer, 400: ErrorSerializer, 429: _THROTTLED},
    )
    def post(self, request):
        serializer = StartLoginRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        started = login_service.start_login(serializer.validated_data["device_id"])
        return Response(
            {
                "login_token": started.token,
                "bot_url": services.bot_url(started.token),
                "expires_in": started.expires_in,
            }
        )


class LoginStatusView(PublicAuthView):
    throttle_classes = [TelegramStatusThrottle]

    @extend_schema(
        operation_id="auth_telegram_status",
        parameters=[LoginStatusQuerySerializer],
        responses={200: LoginStatusResponseSerializer, 400: ErrorSerializer, 429: _THROTTLED},
    )
    def get(self, request):
        query = LoginStatusQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        current = login_service.get_status(query.validated_data["login_token"])
        return Response({"status": current, "needs_code": current == login_service.CONFIRMED})


class VerifyLoginView(PublicAuthView):
    @extend_schema(
        operation_id="auth_telegram_verify",
        request=VerifyLoginRequestSerializer,
        responses={
            200: AuthResponseSerializer,
            400: ErrorSerializer,
            403: ErrorSerializer,
            409: ErrorSerializer,
            410: ErrorSerializer,
            429: _THROTTLED,
        },
    )
    def post(self, request):
        serializer = VerifyLoginRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = services.verify_bot_login(
            serializer.validated_data["login_token"], serializer.validated_data["code"]
        )
        return _auth_response(result)


class WidgetLoginView(PublicAuthView):
    @extend_schema(
        operation_id="auth_telegram_widget",
        request=WidgetLoginRequestSerializer,
        responses={
            200: AuthResponseSerializer,
            400: ErrorSerializer,
            403: ErrorSerializer,
            429: _THROTTLED,
        },
    )
    def post(self, request):
        serializer = WidgetLoginRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # The signature covers the raw fields exactly as sent (including unknown ones).
        raw = {key: str(value) for key, value in request.data.items()}
        return _auth_response(services.widget_login(raw))


class WebhookView(APIView):
    """Telegram Bot API webhook, protected by the secret header (no JWT)."""

    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_classes: list = []
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="telegram_webhook",
        request=WebhookUpdateSerializer,
        responses={200: OpenApiResponse(description="Accepted."), 403: ErrorSerializer},
    )
    def post(self, request):
        if not webhook.is_valid_secret(request.headers.get(webhook.SECRET_HEADER)):
            raise InvalidWebhookSecretError
        WebhookUpdateSerializer(data=request.data).is_valid(raise_exception=True)
        webhook.process_update(request.data)
        return Response({"ok": True}, status=status.HTTP_200_OK)
