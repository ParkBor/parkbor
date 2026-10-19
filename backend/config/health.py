"""``GET /health``: liveness + dependency check for the infra healthcheck and uptime monitors.

No authentication and no throttle (probes run every few seconds); the body names only the check
and ``ok`` / ``fail`` - never hosts, versions, error text or settings. Both checks have short
timeouts, so a hung dependency answers 503 instead of hanging the probe.
"""

import logging
import threading
import time

from django.db import connection, transaction
from drf_spectacular.utils import extend_schema
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.redis_client import get_redis

logger = logging.getLogger(__name__)

DB_TIMEOUT_MS = 2000


def check_database() -> bool:
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            if connection.vendor == "postgresql":
                cursor.execute("SET LOCAL statement_timeout = %s", [DB_TIMEOUT_MS])
            cursor.execute("SELECT 1")
            return cursor.fetchone() == (1,)
    except Exception as exc:  # noqa: BLE001 - any failure means "not healthy"
        logger.error("health: database check failed (%s)", type(exc).__name__)
        return False


def check_redis() -> bool:
    try:
        return bool(get_redis().ping())  # the client has 2 s connect / read timeouts
    except Exception as exc:  # noqa: BLE001
        logger.error("health: redis check failed (%s)", type(exc).__name__)
        return False


READINESS_CACHE_SECONDS = 3.0
_cache: dict = {"at": 0.0, "body": None, "status": 200}
_cache_lock = threading.Lock()


def _readiness() -> tuple[dict, int]:
    """Dependency check, shared by all callers for ``READINESS_CACHE_SECONDS`` so a flood of probes
    costs one database and one Redis round trip per window, not one per request."""
    now = time.monotonic()
    with _cache_lock:
        if _cache["body"] is not None and now - _cache["at"] < READINESS_CACHE_SECONDS:
            return _cache["body"], _cache["status"]
    checks = {"database": check_database(), "redis": check_redis()}
    healthy = all(checks.values())
    body = {
        "status": "ok" if healthy else "unavailable",
        "checks": {name: "ok" if ok else "fail" for name, ok in checks.items()},
    }
    status = 200 if healthy else 503
    with _cache_lock:
        _cache.update(at=now, body=body, status=status)
    return body, status


def reset_readiness_cache() -> None:
    with _cache_lock:
        _cache.update(at=0.0, body=None, status=200)


class _OpenView(APIView):
    """GET only; open to everyone (no token, no throttle, no schema entry)."""

    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_classes: list = []


class HealthView(_OpenView):
    """Readiness: 200 only when PostgreSQL and Redis answer (cached for a few seconds)."""

    @extend_schema(exclude=True)
    def get(self, request):
        body, status = _readiness()
        response = Response(body, status=status)
        response["Cache-Control"] = "no-store"
        return response


class LiveView(_OpenView):
    """Liveness: the process answers HTTP. No I/O at all, so it is the container healthcheck (a
    Redis outage must not make the orchestrator restart healthy API containers)."""

    @extend_schema(exclude=True)
    def get(self, request):
        response = Response({"status": "ok"})
        response["Cache-Control"] = "no-store"
        return response
