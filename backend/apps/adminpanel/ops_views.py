"""Admin operations API (Step 11b): users, bookings, payments, refunds, reviews, settings, audit
log and dashboard statistics. Views stay thin: scoping lives in ``selectors``, rules in the
services. Authentication is the Bearer JWT only (no session, so no CSRF surface); every response
under ``/api/v1/admin/`` is ``Cache-Control: no-store`` (middleware)."""

from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.bookings import conf
from apps.bookings import services as booking_services
from apps.core.exceptions import DomainValidationError, NotFoundError
from apps.core.pagination import StandardPagination
from apps.core.permissions import IsSuperAdmin, is_owner, is_super_admin, lot_owner_id
from apps.core.serializers import error_responses as errors
from apps.payments import refunds as refund_services
from apps.reviews import selectors as review_selectors
from apps.reviews import services as review_services
from apps.reviews.models import ReviewStatus
from apps.reviews.serializers import AdminReviewSerializer, PagedAdminReviewSerializer

from . import selectors, services, stats
from .filters import StableOrderingFilter
from .ops_filters import (
    AuditLogFilter,
    BookingFilter,
    PaymentFilter,
    RefundFilter,
    ReviewFilter,
    UserFilter,
)
from .ops_serializers import (
    AdminBookingDetailSerializer,
    AdminBookingSerializer,
    AdminPaymentSerializer,
    AdminRefundSerializer,
    AdminUserSerializer,
    AuditLogSerializer,
    BookingCancelSerializer,
    OccupancyStatsSerializer,
    PagedAdminBookingSerializer,
    PagedAdminPaymentSerializer,
    PagedAdminRefundSerializer,
    PagedAdminUserSerializer,
    PagedAuditLogSerializer,
    RefundResolveSerializer,
    RevenueQuerySerializer,
    RevenueStatsSerializer,
    SettingsSerializer,
    SettingsUpdateSerializer,
    StatsOverviewSerializer,
    StatsQuerySerializer,
    UserUpdateSerializer,
)
from .throttling import AdminReadThrottle, AdminWriteThrottle

LIST_ERRORS = errors(400, 401, 403, 429)


class IsStaff(BasePermission):
    """ADMIN, or OWNER (whose querysets are scoped to own lots; objects are re-checked)."""

    def has_permission(self, request, view) -> bool:
        return is_super_admin(request.user) or is_owner(request.user)

    def has_object_permission(self, request, view, obj) -> bool:
        if is_super_admin(request.user):
            return True
        owner_id = lot_owner_id(obj)
        return is_owner(request.user) and owner_id is not None and owner_id == request.user.pk


class OpsListView(generics.ListAPIView):
    """Paginated, filterable, stably ordered, read-only list with a per-user throttle."""

    permission_classes = [IsStaff]
    throttle_classes = [AdminReadThrottle]
    pagination_class = StandardPagination
    filter_backends = [DjangoFilterBackend, StableOrderingFilter]
    selector = None

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return self.serializer_class.Meta.model.objects.none()
        return self.scoped_queryset()

    def scoped_queryset(self):
        return type(self).selector(self.request.user)


# --- users ----------------------------------------------------------------------------------------


@extend_schema_view(
    get=extend_schema(
        operation_id="admin_users_list", responses={200: PagedAdminUserSerializer, **LIST_ERRORS}
    )
)
class UserListView(OpsListView):
    permission_classes = [IsSuperAdmin]
    serializer_class = AdminUserSerializer
    filterset_class = UserFilter
    ordering_fields = ["created_at", "role", "first_name", "last_name", "telegram_username"]

    def scoped_queryset(self):
        return selectors.users_for_admin()


class UserDetailView(APIView):
    permission_classes = [IsSuperAdmin]
    throttle_classes = [AdminWriteThrottle]

    @extend_schema(
        operation_id="admin_users_update",
        request=UserUpdateSerializer,
        responses={200: AdminUserSerializer, **errors(400, 401, 403, 404, 409, 429, 503)},
    )
    def patch(self, request, pk):
        body = UserUpdateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        user = services.update_user(actor=request.user, user_id=pk, **body.validated_data)
        return Response(AdminUserSerializer(user).data)


# --- bookings -------------------------------------------------------------------------------------


@extend_schema_view(
    get=extend_schema(
        operation_id="admin_bookings_list",
        responses={200: PagedAdminBookingSerializer, **LIST_ERRORS},
        parameters=[
            OpenApiParameter("from", str, description="Start of the period (ISO 8601 + offset)."),
            OpenApiParameter("to", str, description="End of the period (inclusive)."),
            OpenApiParameter("search", str, description="Licence plate."),
        ],
    )
)
class BookingListView(OpsListView):
    serializer_class = AdminBookingSerializer
    filterset_class = BookingFilter
    selector = staticmethod(selectors.bookings_for_staff)
    ordering_fields = ["starts_at", "ends_at", "created_at", "amount", "status"]


class BookingDetailView(generics.RetrieveAPIView):
    permission_classes = [IsStaff]
    throttle_classes = [AdminReadThrottle]
    serializer_class = AdminBookingDetailSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return AdminBookingDetailSerializer.Meta.model.objects.none()
        return selectors.booking_detail_for_staff(self.request.user)

    @extend_schema(
        operation_id="admin_bookings_retrieve",
        responses={200: AdminBookingDetailSerializer, **errors(401, 403, 404, 429)},
    )
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)


class BookingCancelView(APIView):
    permission_classes = [IsStaff]
    throttle_classes = [AdminWriteThrottle]

    @extend_schema(
        operation_id="admin_bookings_cancel",
        summary="Cancel a PENDING_PAYMENT or CONFIRMED booking (everything paid is refunded)",
        request=BookingCancelSerializer,
        responses={200: AdminBookingSerializer, **errors(400, 401, 403, 404, 409, 429, 503)},
    )
    def post(self, request, pk):
        queryset = selectors.bookings_for_staff(request.user)
        booking = queryset.filter(pk=pk).first()
        if booking is None:
            raise NotFoundError("Booking not found.")
        self.check_object_permissions(request, booking)
        body = BookingCancelSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        booking_services.admin_cancel_booking(
            booking_id=pk, actor=request.user, note=body.validated_data["reason"]
        )
        return Response(AdminBookingSerializer(queryset.get(pk=pk)).data)


# --- payments and refunds -------------------------------------------------------------------------


@extend_schema_view(
    get=extend_schema(
        operation_id="admin_payments_list",
        responses={200: PagedAdminPaymentSerializer, **LIST_ERRORS},
        parameters=[OpenApiParameter("from", str), OpenApiParameter("to", str)],
    )
)
class PaymentListView(OpsListView):
    serializer_class = AdminPaymentSerializer
    filterset_class = PaymentFilter
    selector = staticmethod(selectors.payments_for_staff)
    ordering_fields = ["created_at", "performed_at", "amount", "status"]


@extend_schema_view(
    get=extend_schema(
        operation_id="admin_refunds_list",
        summary="Refunds; ?needs_attention=true = MANUAL and FAILED ones a person must handle",
        responses={200: PagedAdminRefundSerializer, **LIST_ERRORS},
    )
)
class RefundListView(OpsListView):
    serializer_class = AdminRefundSerializer
    filterset_class = RefundFilter
    selector = staticmethod(selectors.refunds_for_staff)
    ordering_fields = ["created_at", "updated_at", "amount", "status"]


class RefundResolveView(APIView):
    permission_classes = [IsSuperAdmin]
    throttle_classes = [AdminWriteThrottle]

    @extend_schema(
        operation_id="admin_refunds_resolve",
        summary="A person settles a MANUAL or FAILED refund (done | retry | failed)",
        request=RefundResolveSerializer,
        responses={200: AdminRefundSerializer, **errors(400, 401, 403, 404, 409, 429, 503)},
    )
    def post(self, request, pk):
        body = RefundResolveSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            refund = refund_services.resolve_manual_refund(
                pk,
                body.validated_data["outcome"],
                actor=request.user,
                note=body.validated_data["note"],
            )
        except ValueError as exc:  # defence in depth: the serializer already checked the note
            raise DomainValidationError("Invalid outcome or note.") from exc
        return Response(AdminRefundSerializer(refund).data)


# --- reviews --------------------------------------------------------------------------------------


@extend_schema_view(
    get=extend_schema(
        operation_id="admin_reviews_list",
        responses={200: PagedAdminReviewSerializer, **LIST_ERRORS},
    )
)
class ReviewListView(OpsListView):
    serializer_class = AdminReviewSerializer
    filterset_class = ReviewFilter
    selector = staticmethod(review_selectors.reviews_for_staff)
    ordering_fields = ["created_at", "rating", "status"]


class ReviewModerationView(APIView):
    permission_classes = [IsSuperAdmin]
    throttle_classes = [AdminWriteThrottle]
    target_status = ReviewStatus.HIDDEN

    def post(self, request, pk):
        review_services.set_status(review_id=pk, actor=request.user, status=self.target_status)
        review = review_selectors.reviews_for_staff(request.user).get(pk=pk)
        return Response(AdminReviewSerializer(review).data)


class ReviewHideView(ReviewModerationView):
    target_status = ReviewStatus.HIDDEN

    @extend_schema(
        operation_id="admin_reviews_hide",
        request=None,
        responses={200: AdminReviewSerializer, **errors(401, 403, 404, 429, 503)},
    )
    def post(self, request, pk):
        return super().post(request, pk)


class ReviewPublishView(ReviewModerationView):
    target_status = ReviewStatus.PUBLISHED

    @extend_schema(
        operation_id="admin_reviews_publish",
        request=None,
        responses={200: AdminReviewSerializer, **errors(401, 403, 404, 429, 503)},
    )
    def post(self, request, pk):
        return super().post(request, pk)


# --- settings and audit ---------------------------------------------------------------------------


class SettingsView(APIView):
    permission_classes = [IsSuperAdmin]

    def get_throttles(self):
        throttle = AdminWriteThrottle if self.request.method == "PATCH" else AdminReadThrottle
        return [throttle()]

    @extend_schema(
        operation_id="admin_settings_get",
        responses={200: SettingsSerializer, **errors(401, 403, 429)},
    )
    def get(self, request):
        return Response(conf.effective_settings())

    @extend_schema(
        operation_id="admin_settings_update",
        request=SettingsUpdateSerializer,
        responses={200: SettingsSerializer, **errors(400, 401, 403, 429, 503)},
    )
    def patch(self, request):
        body = SettingsUpdateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        values = services.update_settings(actor=request.user, changes=body.validated_data)
        return Response(values)


@extend_schema_view(
    get=extend_schema(
        operation_id="admin_audit_logs_list",
        responses={200: PagedAuditLogSerializer, **LIST_ERRORS},
    )
)
class AuditLogListView(OpsListView):
    permission_classes = [IsSuperAdmin]
    serializer_class = AuditLogSerializer
    filterset_class = AuditLogFilter
    ordering_fields = ["created_at", "action"]

    def scoped_queryset(self):
        return selectors.audit_logs()


# --- statistics -----------------------------------------------------------------------------------


class StatsView(APIView):
    permission_classes = [IsStaff]
    throttle_classes = [AdminReadThrottle]
    query_serializer = StatsQuerySerializer

    def scope(self, request, query) -> stats.Scope:
        scope = stats.Scope.build(request.user, query.get("parking_lot"))
        if query.get("parking_lot") is not None and not scope.exists():
            raise NotFoundError("Parking lot not found.")  # foreign = missing
        return scope

    def validated_query(self, request) -> dict:
        serializer = self.query_serializer(data=self.raw_query(request))
        serializer.is_valid(raise_exception=True)
        return serializer.validated_data

    def raw_query(self, request) -> dict:
        return request.query_params


class StatsOverviewView(StatsView):
    @extend_schema(
        operation_id="admin_stats_overview",
        parameters=[StatsQuerySerializer],
        responses={200: StatsOverviewSerializer, **errors(400, 401, 403, 404, 429)},
    )
    def get(self, request):
        return Response(stats.overview(self.scope(request, self.validated_query(request))))


class StatsRevenueView(StatsView):
    query_serializer = RevenueQuerySerializer

    def raw_query(self, request) -> dict:
        params = request.query_params
        data = {
            "parking_lot": params.get("parking_lot"),
            "start": params.get("from"),
            "end": params.get("to"),
        }
        return {key: value for key, value in data.items() if value not in (None, "")}

    @extend_schema(
        operation_id="admin_stats_revenue",
        parameters=[
            StatsQuerySerializer,
            OpenApiParameter("from", str, description="First day (ISO 8601 + offset)."),
            OpenApiParameter("to", str, description="Last day (inclusive); default today."),
        ],
        responses={200: RevenueStatsSerializer, **errors(400, 401, 403, 404, 429)},
    )
    def get(self, request):
        query = self.validated_query(request)
        scope = self.scope(request, query)
        points = stats.revenue_series(scope, query.get("start"), query.get("end"))
        return Response({"results": points})


class StatsOccupancyView(StatsView):
    @extend_schema(
        operation_id="admin_stats_occupancy",
        parameters=[StatsQuerySerializer],
        responses={200: OccupancyStatsSerializer, **errors(400, 401, 403, 404, 429)},
    )
    def get(self, request):
        scope = self.scope(request, self.validated_query(request))
        return Response({"results": stats.occupancy_rows(scope)})
