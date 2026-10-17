from django.conf import settings
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import AccountDisabledError, ServiceUnavailableError
from apps.core.serializers import ErrorSerializer

from . import tickets
from .serializers import WsTicketSerializer
from .throttling import WsTicketThrottle


class WsTicketView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [WsTicketThrottle]

    @extend_schema(
        operation_id="ws_ticket_create",
        request=None,
        responses={
            200: WsTicketSerializer,
            403: ErrorSerializer,
            429: OpenApiResponse(description="Too many requests."),
            503: ErrorSerializer,
        },
    )
    def post(self, request):
        """Trade the JWT for a one-time WebSocket ticket (valid 30 s, usable once)."""
        if not request.user.is_active:
            raise AccountDisabledError
        try:
            ticket = tickets.issue_ticket(request.user.pk)
        except tickets.TicketStoreUnavailable:
            raise ServiceUnavailableError from None
        body = {"ticket": ticket, "expires_in": settings.WS_TICKET_TTL_SECONDS}
        return Response(body, headers={"Cache-Control": "no-store"})
