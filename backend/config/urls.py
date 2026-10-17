from django.conf import settings
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.permissions import AllowAny

# No "admin/" route: the admin panel is the React app.
urlpatterns = [
    path("api/v1/", include("config.api_urls")),
]

if settings.SCHEMA_PUBLIC:
    urlpatterns += [
        path(
            "api/schema/",
            SpectacularAPIView.as_view(permission_classes=[AllowAny], authentication_classes=[]),
            name="schema",
        ),
        path(
            "api/docs/",
            SpectacularSwaggerView.as_view(
                url_name="schema", permission_classes=[AllowAny], authentication_classes=[]
            ),
            name="docs",
        ),
    ]
