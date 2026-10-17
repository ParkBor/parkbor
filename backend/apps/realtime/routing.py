from channels.routing import ProtocolTypeRouter, URLRouter
from django.urls import re_path

from .consumers import AvailabilityConsumer
from .origin import OptionalOriginValidator

websocket_urlpatterns = [
    re_path(r"^ws/availability/?$", AvailabilityConsumer.as_asgi()),
]


def build_application(django_asgi_app):
    """HTTP -> Django; WebSocket -> origin check -> router. The ticket is checked by the
    consumer itself (it may arrive in the query string or as the first message)."""
    return ProtocolTypeRouter(
        {
            "http": django_asgi_app,
            "websocket": OptionalOriginValidator(URLRouter(websocket_urlpatterns)),
        }
    )
