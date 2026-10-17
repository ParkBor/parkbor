"""Operator API (``/api/v1/operator/``; ARCHITECTURE 9.2). Thin: parse -> service -> serialize.

Who may call: OPERATOR (assigned lots), OWNER (own lots), ADMIN (any). Check-in, walk-in and
manual slot changes need an ACTIVE lot; leaving, paying the overstay and READING the lots / map
also work in a suspended lot (cars parked inside must be able to leave). Lot-scoped data answers
404 for a lot the caller may not operate (no probing); the QR endpoints answer ``wrong_lot`` /
``booking_not_found`` uniformly. Every response, errors included, is ``Cache-Control: no-store``.
"""

from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.bookings import checkin, checkout, walkin
from apps.bookings.models import Booking
from apps.core.exceptions import ApiError, DomainValidationError, NotFoundError
from apps.core.pagination import StandardPagination
from apps.core.permissions import IsOwnerOfLot, IsSuperAdmin
from apps.core.serializers import error_responses as errors
from apps.parking import access
from apps.parking.access import IsOperatorOfLot
from apps.parking.models import Slot

from . import scan_guard, selectors, slot_control, slot_map
from . import services as operator_services
from .serializers import (
    CheckInResponseSerializer,
    CheckInSerializer,
    CheckOutResponseSerializer,
    CheckOutSerializer,
    InviteAcceptedSerializer,
    InviteAcceptSerializer,
    OperatorLotSerializer,
    PagedOperatorLotSerializer,
    SlotChangeSerializer,
    SlotMapSerializer,
    SlotStatusSerializer,
    WalkInResponseSerializer,
    WalkInSerializer,
)
from .throttling import (
    OperatorInviteAcceptThrottle,
    OperatorReadThrottle,
    OperatorScanThrottle,
    OperatorWriteThrottle,
)

GATE_PERMISSIONS = [IsOperatorOfLot | IsOwnerOfLot | IsSuperAdmin]


class ParkingLotRequired(DomainValidationError):
    default_detail = "Send parking_lot_id: you may operate more than one parking lot."
    default_code = "parking_lot_required"


def _booking_for_display(booking_id) -> Booking:
    return Booking.objects.select_related("slot__zone__parking_lot").get(pk=booking_id)


def _working_lot_id(user, supplied, *, active_only: bool):
    """The lot a scan belongs to: what the app sent, else the caller's only lot. A caller with
    several lots must say which (otherwise a scan could land in the wrong one)."""
    if supplied is not None:
        return supplied
    ids = list(access.operable_lots(user, active_only=active_only).values_list("pk", flat=True)[:2])
    if len(ids) > 1:
        raise ParkingLotRequired
    return ids[0] if ids else None


class GateView(APIView):
    permission_classes = GATE_PERMISSIONS

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"  # also for errors: they can name a booking
        return response


class OperatorLotListView(GateView):
    throttle_classes = [OperatorReadThrottle]

    @extend_schema(
        operation_id="operator_parkings_list",
        summary="Parking lots this user may operate (any status; check `status`)",
        responses={200: PagedOperatorLotSerializer, **errors(401, 403, 429)},
    )
    def get(self, request):
        queryset = access.operable_lots(request.user, active_only=False).order_by("name", "id")
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        return paginator.get_paginated_response(OperatorLotSerializer(page, many=True).data)


class OperatorSlotMapView(GateView):
    throttle_classes = [OperatorReadThrottle]

    @extend_schema(
        operation_id="operator_slots_map",
        summary="Slot map: zone, floor, code, type, physical status, current and next booking",
        responses={200: SlotMapSerializer, **errors(401, 403, 404, 429)},
    )
    def get(self, request, pk):
        lot = access.get_operable_lot(request.user, pk, active_only=False)
        if lot is None:
            raise NotFoundError("Parking lot not found.")
        self.check_object_permissions(request, lot)
        rows, truncated = slot_map.slot_map(lot, timezone.now())
        payload = {"parking_lot": lot, "slots": rows, "truncated": truncated}
        return Response(SlotMapSerializer(payload).data)


class CheckInView(GateView):
    throttle_classes = [OperatorScanThrottle]

    @extend_schema(
        operation_id="operator_checkin",
        summary="Check a driver in by the scanned entry QR (CONFIRMED -> ACTIVE)",
        description="200 `allowed: true, result: checked_in` = admitted (green). 200 `allowed: "
        "false, result: already_checked_in` = the car is already inside; this scan admits "
        "nobody (amber). A refusal (red) is an error body `{detail, code}` whose `code` is the "
        "reason shown on the screen.",
        request=CheckInSerializer,
        responses={
            200: CheckInResponseSerializer,
            **errors(400, 401, 403, 409, 429, 503),
        },
    )
    def post(self, request):
        body = CheckInSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        user = request.user
        lot_id = _working_lot_id(user, data.get("parking_lot_id"), active_only=True)
        scan_guard.assert_open(user)
        try:
            result = checkin.check_in(
                operator=user,
                token=data["qr_token"],
                expected_lot_id=lot_id,
                plate_number=data.get("plate_number"),
            )
        except ApiError as exc:
            scan_guard.record_failure(user, exc, scan_guard.CHECK_IN)
            raise
        booking = _booking_for_display(result.booking.pk)
        payload = {
            "allowed": result.allowed,
            "result": result.code,
            "booking": booking,
            "next": selectors.next_action(booking),
        }
        return Response(CheckInResponseSerializer(payload).data)


class CheckOutView(GateView):
    throttle_classes = [OperatorScanThrottle]

    @extend_schema(
        operation_id="operator_checkout",
        summary="Check a car out: exit QR, or booking_id + plate for a walk-in "
        "(ACTIVE/OVERSTAY -> COMPLETED)",
        description="An ONLINE booking leaves only with its exit QR (403 `exit_qr_required` "
        "otherwise); an OWNER / ADMIN may use `booking_id` + `plate_number` + `override: true` "
        "+ `note`. Overstay is priced here and collected in cash: `collect=false` leaves it "
        "`due`, `collect=true` marks it `collected`. Repeating the call is harmless "
        "(`already_completed`) and, with `collect=true`, settles a due amount. Never locked by "
        "the scan guard: cars can always leave, also from a suspended lot.",
        request=CheckOutSerializer,
        responses={
            200: CheckOutResponseSerializer,
            **errors(400, 401, 403, 404, 409, 429, 503),
        },
    )
    def post(self, request):
        body = CheckOutSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        user = request.user
        lot_id = _working_lot_id(user, data.get("parking_lot_id"), active_only=False)
        try:
            result = checkout.check_out(
                operator=user,
                request=checkout.CheckOutRequest(
                    token=data.get("qr_token"),
                    booking_id=data.get("booking_id"),
                    plate_number=data.get("plate_number"),
                    collect=data["collect"],
                    expected_lot_id=lot_id,
                    override=data["override"],
                    note=data.get("note", ""),
                ),
            )
        except ApiError as exc:
            scan_guard.record_failure(user, exc, scan_guard.CHECK_OUT)  # counts, never locks
            raise
        booking = _booking_for_display(result.booking.pk)
        payload = {
            "allowed": result.code == checkout.RESULT_COMPLETED,
            "result": result.code,
            "booking": booking,
            "actual_minutes": result.actual_minutes,
            "overstay": {
                "minutes": booking.overstay_minutes,
                "amount": booking.overstay_amount,
                "status": booking.overstay_status,
            },
            "to_collect": result.to_collect,
        }
        return Response(CheckOutResponseSerializer(payload).data)


class WalkInView(GateView):
    throttle_classes = [OperatorWriteThrottle]

    @extend_schema(
        operation_id="operator_walk_in",
        summary="Register a car without a booking in a free slot",
        request=WalkInSerializer,
        responses={
            201: WalkInResponseSerializer,
            **errors(400, 401, 403, 404, 409, 422, 429, 503),
        },
    )
    def post(self, request):
        body = WalkInSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        created = walkin.register_walk_in(
            operator=request.user,
            slot_id=data["slot_id"],
            plate_number=data["plate_number"],
            vehicle_type=data["vehicle_type"],
        )
        booking = _booking_for_display(created.pk)
        payload = {"result": "registered", "booking": booking, "valid_until": booking.ends_at}
        return Response(WalkInResponseSerializer(payload).data, status=status.HTTP_201_CREATED)


class OperatorSlotView(GateView):
    throttle_classes = [OperatorWriteThrottle]

    @extend_schema(
        operation_id="operator_slot_status",
        summary="Set a slot's physical status by hand: FREE or OUT_OF_SERVICE",
        request=SlotStatusSerializer,
        responses={200: SlotChangeSerializer, **errors(400, 401, 403, 404, 409, 429, 503)},
    )
    def patch(self, request, pk):
        body = SlotStatusSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        change = slot_control.set_slot_status(
            operator=request.user,
            slot_id=pk,
            status=body.validated_data["status"],
            force=body.validated_data["force"],
        )
        slot = Slot.objects.select_related("zone").get(pk=pk)
        change = slot_control.SlotChange(slot=slot, affected_bookings=change.affected_bookings)
        return Response(SlotChangeSerializer(change).data)


class AcceptInviteView(APIView):
    """A staff member joins a lot with the owner's one-time code. Any signed-in account."""

    throttle_classes = [OperatorInviteAcceptThrottle]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    @extend_schema(
        operation_id="me_operator_invite_accept",
        summary="Accept a staff invitation code (you become an operator of that lot)",
        description="Every refusal (wrong, expired, used or revoked code; the lot is not "
        "active; the account is an owner or admin) is the same `400 invite_invalid`. After "
        "several wrong codes: `429 invite_locked` with `Retry-After`.",
        request=InviteAcceptSerializer,
        responses={200: InviteAcceptedSerializer, **errors(400, 401, 429, 503)},
    )
    def post(self, request):
        body = InviteAcceptSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        lot = operator_services.accept_invite(user=request.user, code=body.validated_data["code"])
        return Response(InviteAcceptedSerializer({"parking_lot": lot}).data)
