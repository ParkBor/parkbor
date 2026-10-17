from django.urls import path

from . import views

urlpatterns = [
    path("bookings", views.BookingListCreateView.as_view(), name="bookings"),
    path("bookings/<uuid:pk>", views.BookingDetailView.as_view(), name="booking-detail"),
    path("bookings/<uuid:pk>/cancel", views.BookingCancelView.as_view(), name="booking-cancel"),
    path(
        "bookings/<uuid:pk>/cancel-preview",
        views.BookingCancelPreviewView.as_view(),
        name="booking-cancel-preview",
    ),
    path("bookings/<uuid:pk>/extend", views.BookingExtendView.as_view(), name="booking-extend"),
    path("bookings/<uuid:pk>/qr", views.BookingQrView.as_view(), name="booking-qr"),
    path(
        "parkings/<uuid:pk>/availability",
        views.ParkingAvailabilityView.as_view(),
        name="parking-availability",
    ),
    path("parkings/<uuid:pk>/price", views.ParkingPriceView.as_view(), name="parking-price"),
]
