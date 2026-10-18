"""``GET /health``: liveness + dependency check for the infra healthcheck and uptime monitors.

No authentication and no throttle (probes run every few seconds); the body names only the check
and ``ok`` / ``fail`` - never hosts, versions, error text or settings. Both checks have short
timeouts, so a hung dependency answers 503 instead of hanging the probe.
"""

import logging

from django.db import connection, transaction
from django.http import JsonResponse
from django.views.decorators.http import require_GET

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


@require_GET
def health(request):
    checks = {"database": check_database(), "redis": check_redis()}
    healthy = all(checks.values())
    body = {
        "status": "ok" if healthy else "unavailable",
        "checks": {name: "ok" if ok else "fail" for name, ok in checks.items()},
    }
    response = JsonResponse(body, status=200 if healthy else 503)
    response["Cache-Control"] = "no-store"
    return response
