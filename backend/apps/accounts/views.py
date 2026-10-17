from django.core.exceptions import ObjectDoesNotExist
from drf_spectacular.utils import OpenApiResponse, extend_schema, extend_schema_view
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.views import TokenRefreshView

from apps.accounts import services
from apps.accounts.serializers import (
    DeviceDeleteSerializer,
    DeviceSerializer,
    LogoutSerializer,
    ProfileUpdateSerializer,
    UserSerializer,
)
from apps.core.exceptions import UserNotFoundError
from apps.core.serializers import ErrorSerializer
from apps.core.throttling import AuthenticatedUserThrottle
from apps.telegram_bot.throttling import TokenRefreshThrottle


class MeView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthenticatedUserThrottle]

    @extend_schema(operation_id="me_retrieve", responses=UserSerializer)
    def get(self, request):
        return Response(UserSerializer(request.user).data)

    @extend_schema(
        operation_id="me_partial_update",
        request=ProfileUpdateSerializer,
        responses={200: UserSerializer, 400: ErrorSerializer},
    )
    def patch(self, request):
        serializer = ProfileUpdateSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        user = services.update_profile(request.user, serializer.validated_data)
        return Response(UserSerializer(user).data)


class DevicesView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthenticatedUserThrottle]

    @extend_schema(
        operation_id="me_devices_register",
        request=DeviceSerializer,
        responses={201: DeviceSerializer, 200: DeviceSerializer},
    )
    def post(self, request):
        serializer = DeviceSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        device, created = services.register_device(
            request.user,
            platform=serializer.validated_data["platform"],
            expo_push_token=serializer.validated_data["expo_push_token"],
        )
        code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
        return Response(DeviceSerializer(device).data, status=code)

    @extend_schema(
        operation_id="me_devices_remove",
        request=DeviceDeleteSerializer,
        responses={204: OpenApiResponse(description="Removed (idempotent).")},
    )
    def delete(self, request):
        serializer = DeviceDeleteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.remove_device(request.user, serializer.validated_data["expo_push_token"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthenticatedUserThrottle]

    @extend_schema(
        operation_id="auth_logout",
        request=LogoutSerializer,
        responses={
            204: OpenApiResponse(description="Refresh token revoked."),
            400: ErrorSerializer,
        },
    )
    def post(self, request):
        serializer = LogoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.logout(
            request.user,
            serializer.validated_data["refresh"],
            serializer.validated_data.get("expo_push_token"),
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema_view(
    post=extend_schema(
        operation_id="auth_token_refresh",
        request=TokenRefreshSerializer,
        responses={
            200: TokenRefreshSerializer,
            401: ErrorSerializer,
            429: OpenApiResponse(description="Too many requests."),
        },
    )
)
class RefreshView(TokenRefreshView):
    """Rotate the refresh token (the old one is blacklisted). Public by design."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [TokenRefreshThrottle]

    def post(self, request, *args, **kwargs):
        try:
            return super().post(request, *args, **kwargs)
        except ObjectDoesNotExist:
            # simplejwt looks the user up by the token's user_id; a deleted account must read as
            # a session verdict (401), not as a generic 404.
            raise UserNotFoundError from None
