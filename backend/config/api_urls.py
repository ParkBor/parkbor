from django.urls import include, path

urlpatterns = [
    path("", include("apps.accounts.urls")),
    path("", include("apps.telegram_bot.urls")),
    path("", include("apps.parking.urls")),
    path("", include("apps.routing.urls")),
    path("", include("apps.vehicles.urls")),
    path("", include("apps.bookings.urls")),
    path("", include("apps.payments.urls")),
    path("", include("apps.realtime.urls")),
    path("me/", include("apps.operators.me_urls")),
    path("operator/", include("apps.operators.urls")),
    path("admin/", include("apps.adminpanel.urls")),
]
