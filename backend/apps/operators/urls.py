from django.urls import path

from . import views

urlpatterns = [
    path("parkings", views.OperatorLotListView.as_view(), name="operator-parkings"),
    path("parkings/<uuid:pk>/slots", views.OperatorSlotMapView.as_view(), name="operator-slots"),
    path("checkin", views.CheckInView.as_view(), name="operator-checkin"),
    path("checkout", views.CheckOutView.as_view(), name="operator-checkout"),
    path("walk-in", views.WalkInView.as_view(), name="operator-walk-in"),
    path("slots/<uuid:pk>", views.OperatorSlotView.as_view(), name="operator-slot"),
]
