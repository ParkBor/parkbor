from django.urls import path

from apps.accounts import views

urlpatterns = [
    path("auth/token/refresh", views.RefreshView.as_view(), name="token-refresh"),
    path("auth/logout", views.LogoutView.as_view(), name="logout"),
    path("me", views.MeView.as_view(), name="me"),
    path("me/devices", views.DevicesView.as_view(), name="me-devices"),
]
