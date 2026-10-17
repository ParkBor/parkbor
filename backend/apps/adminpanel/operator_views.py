"""Staff management actions of the parking-lot viewset (ARCHITECTURE 2, 6.3, 9.3).

Owner of THIS lot or ADMIN only (the viewset's permission + queryset scoping: a foreign lot is
404). The operator list shows ids and a masked name, never contact details; people join through
one-time invitation codes (``apps.operators.services``), not through lookups by phone/username.
"""

from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.pagination import StandardPagination
from apps.core.serializers import error_responses as errors
from apps.operators import selectors as operator_selectors
from apps.operators import services as operator_services

from .operator_serializers import (
    InviteCreatedSerializer,
    InviteCreateSerializer,
    InviteSerializer,
    OperatorAssignmentSerializer,
    PagedInviteSerializer,
    PagedOperatorAssignmentSerializer,
)
from .throttling import OperatorAssignThrottle

UUID_PATTERN = r"[0-9a-fA-F-]{36}"


def _no_store(response: Response) -> Response:
    response["Cache-Control"] = "no-store"
    return response


STAFF_ACTIONS = frozenset(
    {"operators", "revoke_operator", "operator_invites", "revoke_operator_invite"}
)


class OperatorStaffMixin:
    """Mixed into ``ParkingLotViewSet``."""

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        if getattr(self, "action", None) in STAFF_ACTIONS:
            response["Cache-Control"] = "no-store"  # also for errors
        return response

    @extend_schema(
        operation_id="admin_parking_operators_list",
        summary="Operators of the lot (ids and a masked name only)",
        responses={200: PagedOperatorAssignmentSerializer, **errors(401, 403, 404)},
    )
    @action(detail=True, methods=["get"], url_path="operators")
    def operators(self, request, pk=None):
        lot = self.get_object()
        paginator = StandardPagination()
        page = paginator.paginate_queryset(
            operator_selectors.active_assignments(lot).order_by("created_at", "id"),
            request,
            view=self,
        )
        data = OperatorAssignmentSerializer(page, many=True, context={"request": request}).data
        return _no_store(paginator.get_paginated_response(data))

    @extend_schema(
        operation_id="admin_parking_operators_revoke",
        request=None,
        responses={204: None, **errors(401, 403, 404, 429, 503)},
    )
    @action(
        detail=True,
        methods=["delete"],
        url_path=rf"operators/(?P<assignment_id>{UUID_PATTERN})",
        throttle_classes=[OperatorAssignThrottle],
    )
    def revoke_operator(self, request, pk=None, assignment_id=None):
        """End the assignment (idempotent); the last one returns the account to DRIVER."""
        operator_services.revoke_operator(
            lot=self.get_object(), assignment_id=assignment_id, actor=request.user
        )
        return _no_store(Response(status=status.HTTP_204_NO_CONTENT))

    @extend_schema(
        methods=["GET"],
        operation_id="admin_parking_operator_invites_list",
        summary="Open invitation codes of the lot (the codes themselves are never shown)",
        responses={200: PagedInviteSerializer, **errors(401, 403, 404)},
    )
    @extend_schema(
        methods=["POST"],
        operation_id="admin_parking_operator_invites_create",
        summary="Create a one-time code for a staff member (shown once)",
        request=InviteCreateSerializer,
        responses={201: InviteCreatedSerializer, **errors(400, 401, 403, 404, 409, 429, 503)},
    )
    @action(
        detail=True,
        methods=["get", "post"],
        url_path="operator-invites",
        throttle_classes=[OperatorAssignThrottle],
    )
    def operator_invites(self, request, pk=None):
        lot = self.get_object()
        if request.method == "GET":
            paginator = StandardPagination()
            queryset = operator_selectors.open_invites(lot, timezone.now()).order_by(
                "-created_at", "id"
            )
            page = paginator.paginate_queryset(queryset, request, view=self)
            return _no_store(
                paginator.get_paginated_response(InviteSerializer(page, many=True).data)
            )
        body = InviteCreateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        invite, code = operator_services.create_invite(
            lot=lot, actor=request.user, hours=body.validated_data.get("expires_in_hours")
        )
        payload = {"invite_id": invite.pk, "code": code, "expires_at": invite.expires_at}
        return _no_store(
            Response(InviteCreatedSerializer(payload).data, status=status.HTTP_201_CREATED)
        )

    @extend_schema(
        operation_id="admin_parking_operator_invites_revoke",
        request=None,
        responses={204: None, **errors(401, 403, 404, 429, 503)},
    )
    @action(
        detail=True,
        methods=["delete"],
        url_path=rf"operator-invites/(?P<invite_id>{UUID_PATTERN})",
        throttle_classes=[OperatorAssignThrottle],
    )
    def revoke_operator_invite(self, request, pk=None, invite_id=None):
        """Cancel an open code (idempotent)."""
        operator_services.revoke_invite(
            lot=self.get_object(), invite_id=invite_id, actor=request.user
        )
        return _no_store(Response(status=status.HTTP_204_NO_CONTENT))
