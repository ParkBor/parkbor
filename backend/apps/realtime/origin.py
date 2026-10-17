"""Origin check for the WebSocket handshake.

Channels' stock ``AllowedHostsOriginValidator`` refuses a handshake WITHOUT an ``Origin`` header,
which is exactly what a React Native client sends. Browsers always send one, and a browser is the
only client a cross-site attack can come from, so: no Origin -> allowed (the one-time ticket is
the credential anyway); an Origin -> must be one of ALLOWED_HOSTS / CORS_ALLOWED_ORIGINS.
"""

from channels.security.websocket import OriginValidator
from django.conf import settings

LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"]


class OptionalOriginValidator(OriginValidator):
    def __init__(self, application):
        super().__init__(application, allowed_origins=[])

    @property
    def allowed_origins(self):
        hosts = list(settings.ALLOWED_HOSTS) or (LOCAL_HOSTS if settings.DEBUG else [])
        return [*hosts, *settings.CORS_ALLOWED_ORIGINS]

    @allowed_origins.setter
    def allowed_origins(self, value):  # the base __init__ assigns it; the property wins
        return None

    def valid_origin(self, parsed_origin):
        if parsed_origin is None:  # not a browser
            return True
        return self.validate_origin(parsed_origin)
