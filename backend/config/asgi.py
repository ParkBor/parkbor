import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")

# Django must be set up before anything that imports models (the consumers do).
django_asgi_app = get_asgi_application()

from apps.realtime.routing import build_application  # noqa: E402

# One ASGI process serves HTTP and WebSocket (ARCHITECTURE 12, 17); WSGI stays for commands.
application = build_application(django_asgi_app)
