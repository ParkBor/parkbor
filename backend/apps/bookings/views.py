"""Driver booking endpoints. Thin: parse -> service -> serialize."""

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import NotFoundError
from apps.core.pagination import StandardPagination
from apps.core.permissions import IsRecordOwner
from apps.core.serializers import error_responses as errors
from apps.core.throttling import AuthenticatedUserThrottle
from apps.payments import checkout as payments_checkout
from apps.vehicles.models import Vehicle

from . import idempotency, qr, quotes, selectors, services
from .errors import QrNotAvailable, rule_violation
from .serializers import (
    AvailabilitySerializer,
    BookingCreateSerializer,
    BookingListQuerySerializer,
    BookingSerializer,
    CancelPreviewSerializer,
    ExtendedBookingSerializer,
    ExtendSerializer,
    PagedBookingSerializer,
    PriceSerializer,
    QrSerializer,
    QuoteQuerySerializer,
    RequiredSlotTypeQuerySerializer,
)
from .state import BookingStatus
from .throttling import (
    BookingCreateThrottle,
    BookingMutateThrottle,
    BookingQrThrottle,
    BookingQuoteThrottle,
)


def no_store(response: Response) -> Response:
    """Booking data is personal and changes quickly: never let a cache keep it."""
    response["Cache-Control"] = "no-store"
    return response


IDEMPOTENCY_HEADER = OpenApiParameter(
    "Idempotency-Key",
    OpenApiTypes.STR,
    location=OpenApiParameter.HEADER,
    required=True,
    description="Client-generated unique key (8-128 chars). Repeating the request with the "
    "same key and body returns the first booking (200, header Idempotent-Replayed: true); "
    "the same key with another body is 422 idempotency_conflict.",
)
FROM_PARAM = OpenApiParameter(
    "from", OpenApiTypes.DATETIME, required=True, description="Period start, ISO 8601 + offset."
)
TO_PARAM = OpenApiParameter(
    "to", OpenApiTypes.DATETIME, required=True, description="Period end, ISO 8601 + offset."
)
SLOT_TYPES = ["STANDARD", "EV", "DISABLED", "LARGE"]
SLOT_TYPE_PARAM = OpenApiParameter("slot_type", OpenApiTypes.STR, enum=SLOT_TYPES)


class OwnedBookingMixin:
    permission_classes = [IsRecordOwner]

    def get_booking(self, request, pk):
        booking = selectors.get_user_booking(request.user, pk)
        if booking is None:
            raise NotFoundError("Booking not found.")
        self.check_object_permissions(request, booking)
        return booking


class BookingListCreateView(OwnedBookingMixin, APIView):
    def get_throttles(self):
        cls = BookingCreateThrottle if self.request.method == "POST" else AuthenticatedUserThrottle
        return [cls()]

    @extend_schema(
        operation_id="bookings_list",
        summary="My bookings",
        parameters=[BookingListQuerySerializer],
        responses={200: PagedBookingSerializer, **errors(400, 401, 429)},
    )
    def get(self, request):
        query = BookingListQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        queryset = selectors.filter_bookings(
            selectors.bookings_for_user(request.user),
            statuses=query.validated_data.get("status"),
            scope=query.validated_data.get("scope"),
        )
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        return no_store(paginator.get_paginated_response(BookingSerializer(page, many=True).data))

    @extend_schema(
        operation_id="bookings_create",
        summary="Create a booking (holds a slot for 10 minutes until paid)",
        parameters=[IDEMPOTENCY_HEADER],
        request=BookingCreateSerializer,
        responses={
            201: BookingSerializer,
            200: BookingSerializer,
            **errors(400, 401, 404, 409, 422, 429, 503),
        },
    )
    def post(self, request):
        key = idempotency.validate_key(request.headers.get("Idempotency-Key"))
        body = BookingCreateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        payments_checkout.ensure_available(data["payment_provider"])
        vehicle = Vehicle.objects.filter(pk=data["vehicle_id"], user=request.user).first()
        if vehicle is None:
            raise rule_violation("vehicle_not_found", "Vehicle not found.")
        booking, created = services.create_booking_idempotent(
            idempotency_key=key,
            user=request.user,
            lot_id=data["parking_lot_id"],
            slot_type=data["slot_type"],
            vehicle=vehicle,
            start=data["start"],
            end=data["end"],
            preferred_slot_id=data["preferred_slot_id"],
            payment_provider=data["payment_provider"],
        )
        fresh = selectors.get_user_booking(request.user, booking.pk)
        response = Response(
            BookingSerializer(fresh).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )
        if not created:
            response["Idempotent-Replayed"] = "true"
        return no_store(response)


class BookingDetailView(OwnedBookingMixin, APIView):
    throttle_classes = [AuthenticatedUserThrottle]

    @extend_schema(
        operation_id="bookings_retrieve",
        responses={200: BookingSerializer, **errors(401, 404, 429)},
    )
    def get(self, request, pk):
        return no_store(Response(BookingSerializer(self.get_booking(request, pk)).data))


class BookingCancelView(OwnedBookingMixin, APIView):
    throttle_classes = [BookingMutateThrottle]

    @extend_schema(
        operation_id="bookings_cancel",
        summary="Cancel (CONFIRMED: refund by policy; PENDING_PAYMENT: no refund). Repeating "
        "the call on an already cancelled booking returns it unchanged (200).",
        request=None,
        responses={200: BookingSerializer, **errors(401, 404, 409, 429, 503)},
    )
    def post(self, request, pk):
        self.get_booking(request, pk)
        services.cancel_booking(booking_id=pk, user=request.user)
        return no_store(Response(BookingSerializer(self.get_booking(request, pk)).data))


class BookingCancelPreviewView(OwnedBookingMixin, APIView):
    throttle_classes = [AuthenticatedUserThrottle]

    @extend_schema(
        operation_id="bookings_cancel_preview",
        summary="What a cancellation right now would refund",
        responses={200: CancelPreviewSerializer, **errors(401, 404, 429)},
    )
    def get(self, request, pk):
        preview = services.cancel_preview(self.get_booking(request, pk))
        return Response(CancelPreviewSerializer(preview).data)


class BookingExtendView(OwnedBookingMixin, APIView):
    throttle_classes = [BookingMutateThrottle]

    @extend_schema(
        operation_id="bookings_extend",
        summary="Move the end of a CONFIRMED/ACTIVE booking later (409 extend_unavailable "
        "until payments can collect the extra amount, Step 8)",
        request=ExtendSerializer,
        responses={200: ExtendedBookingSerializer, **errors(400, 401, 404, 409, 422, 429, 503)},
    )
    def post(self, request, pk):
        self.get_booking(request, pk)
        body = ExtendSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        result = services.extend_booking(
            booking_id=pk, user=request.user, new_end=body.validated_data["end"]
        )
        serializer = ExtendedBookingSerializer(
            self.get_booking(request, pk), context={"extra_amount": result.extra_amount}
        )
        return no_store(Response(serializer.data))


class BookingQrView(OwnedBookingMixin, APIView):
    throttle_classes = [BookingQrThrottle]

    @extend_schema(
        operation_id="bookings_qr",
        summary="Signed one-time QR token: entry code (CONFIRMED) or exit code (ACTIVE/OVERSTAY)",
        responses={200: QrSerializer, **errors(401, 404, 409, 429)},
    )
    def get(self, request, pk):
        booking = self.get_booking(request, pk)
        if booking.status == BookingStatus.CONFIRMED:
            token, expires_at = qr.issue_token(booking)
            purpose = qr.PURPOSE_ENTRY
        elif booking.status in (BookingStatus.ACTIVE, BookingStatus.OVERSTAY):
            token, expires_at = qr.issue_exit_token(booking)  # the nonce was renewed at check-in
            purpose = qr.PURPOSE_EXIT
        else:
            raise QrNotAvailable
        payload = {"qr_token": token, "expires_at": expires_at, "purpose": purpose}
        return no_store(Response(QrSerializer(payload).data))


class _QuoteView(APIView):
    permission_classes = [IsRecordOwner]  # any authenticated, active user
    throttle_classes = [BookingQuoteThrottle]
    query_serializer = QuoteQuerySerializer

    def parse(self, request):
        params = request.query_params
        raw = {
            "start": params.get("from"),
            "end": params.get("to"),
            "slot_type": params.get("slot_type"),
        }
        query = self.query_serializer(data={k: v for k, v in raw.items() if v is not None})
        query.is_valid(raise_exception=True)
        return query.validated_data


class ParkingAvailabilityView(_QuoteView):
    @extend_schema(
        operation_id="parkings_availability",
        summary="Free slots for a period",
        parameters=[FROM_PARAM, TO_PARAM, SLOT_TYPE_PARAM],
        responses={200: AvailabilitySerializer, **errors(400, 401, 404, 422, 429)},
    )
    def get(self, request, pk):
        data = self.parse(request)
        result = quotes.get_availability(
            lot_id=pk, slot_type=data.get("slot_type"), start=data["start"], end=data["end"]
        )
        return Response(AvailabilitySerializer(result).data)


class ParkingPriceView(_QuoteView):
    query_serializer = RequiredSlotTypeQuerySerializer

    @extend_schema(
        operation_id="parkings_price",
        summary="Price breakdown for a period",
        parameters=[
            FROM_PARAM,
            TO_PARAM,
            OpenApiParameter(
                "slot_type",
                OpenApiTypes.STR,
                required=True,
                enum=["STANDARD", "EV", "DISABLED", "LARGE"],
            ),
        ],
        responses={200: PriceSerializer, **errors(400, 401, 404, 422, 429)},
    )
    def get(self, request, pk):
        data = self.parse(request)
        result = quotes.quote_price(
            lot_id=pk, slot_type=data["slot_type"], start=data["start"], end=data["end"]
        )
        quote = result.quote
        payload = {
            "slot_type": data["slot_type"],
            "start": data["start"],
            "end": data["end"],
            "price_per_hour": quote.price_per_hour,
            "total_minutes": quote.total_minutes,
            "free_minutes": quote.free_minutes,
            "billed_minutes": quote.billed_minutes,
            "segments": quote.segments,
            "subtotal": quote.subtotal,
            "occupancy": quote.occupancy,
            "dynamic_factor": quote.dynamic_factor,
            "total": quote.total,
            "available_slots": result.available,
        }
        return Response(PriceSerializer(payload).data)
