from django.urls import path

from . import views

urlpatterns = [
    path("parkings/nearby", views.NearbyParkingsView.as_view(), name="parkings-nearby"),
]
