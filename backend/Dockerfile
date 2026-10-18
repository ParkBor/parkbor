FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=config.settings.prod \
    WEB_CONCURRENCY=3

# Build with --build-arg RELEASE=<git sha>: becomes the Sentry release (override at runtime with
# SENTRY_RELEASE if needed).
ARG RELEASE=""
ENV SENTRY_RELEASE=${RELEASE}
LABEL org.opencontainers.image.title="habi-backend" org.opencontainers.image.revision="${RELEASE}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin libgdal-dev libgeos-dev libproj-dev \
    && apt-get clean \
    && find /var/lib/apt/lists -type f -delete

RUN useradd --create-home app
WORKDIR /app

COPY requirements/ requirements/
RUN pip install --no-cache-dir -r requirements/prod.txt

COPY --chown=app:app . .
USER app
EXPOSE 8000

# TCP-level check: an HTTP probe would hit SECURE_SSL_REDIRECT / ALLOWED_HOSTS.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import socket; socket.create_connection(('127.0.0.1', 8000), 3).close()"]

# One ASGI process serves HTTP and WebSocket (config.asgi). Worker count comes from
# WEB_CONCURRENCY (override per environment). --ws-max-size caps a WebSocket frame (the consumer
# enforces its own 4 KB message limit on top); --lifespan off: Channels' router has no lifespan
# handler. The access log is on: tickets travel in the WS query string but are one-time (12).
# WSGI (config.wsgi) stays for management commands; gunicorn remains in prod.txt for it.
CMD ["sh", "-c", "exec uvicorn config.asgi:application --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY} --lifespan off --ws-max-size 16384 --timeout-graceful-shutdown 30 --proxy-headers"]
