from django.urls import path

from . import views

urlpatterns = [
    path("parkings/<uuid:pk>/reviews", views.LotReviewsView.as_view(), name="parking-reviews"),
]
