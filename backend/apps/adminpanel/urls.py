from django.urls import path
from rest_framework.routers import DefaultRouter

from . import ops_views as ops
from .views import ParkingLotViewSet, SlotViewSet, TariffViewSet, ZoneViewSet

router = DefaultRouter(trailing_slash=False)
router.register("parkings", ParkingLotViewSet, basename="admin-parking")
router.register("zones", ZoneViewSet, basename="admin-zone")
router.register("slots", SlotViewSet, basename="admin-slot")
router.register("tariffs", TariffViewSet, basename="admin-tariff")

urlpatterns = [
    path("users", ops.UserListView.as_view(), name="admin-users"),
    path("users/<uuid:pk>", ops.UserDetailView.as_view(), name="admin-user"),
    path("bookings", ops.BookingListView.as_view(), name="admin-bookings"),
    path("bookings/<uuid:pk>", ops.BookingDetailView.as_view(), name="admin-booking"),
    path("bookings/<uuid:pk>/cancel", ops.BookingCancelView.as_view(), name="admin-booking-cancel"),
    path("payments", ops.PaymentListView.as_view(), name="admin-payments"),
    path("refunds", ops.RefundListView.as_view(), name="admin-refunds"),
    path("refunds/<uuid:pk>/resolve", ops.RefundResolveView.as_view(), name="admin-refund-resolve"),
    path("reviews", ops.ReviewListView.as_view(), name="admin-reviews"),
    path("reviews/<uuid:pk>/hide", ops.ReviewHideView.as_view(), name="admin-review-hide"),
    path("reviews/<uuid:pk>/publish", ops.ReviewPublishView.as_view(), name="admin-review-publish"),
    path("settings", ops.SettingsView.as_view(), name="admin-settings"),
    path("audit-logs", ops.AuditLogListView.as_view(), name="admin-audit-logs"),
    path("stats/overview", ops.StatsOverviewView.as_view(), name="admin-stats-overview"),
    path("stats/revenue", ops.StatsRevenueView.as_view(), name="admin-stats-revenue"),
    path("stats/occupancy", ops.StatsOccupancyView.as_view(), name="admin-stats-occupancy"),
    *router.urls,
]
