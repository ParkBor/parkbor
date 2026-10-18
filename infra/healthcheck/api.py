"""Container healthcheck for the ASGI API (run inside the backend image).

Sends a real HTTP request through the full Django stack the way nginx would (Host from
ALLOWED_HOSTS, X-Forwarded-Proto: https so SECURE_SSL_REDIRECT does not answer 301). The probe is
GET /health (no auth): 200 only when PostgreSQL and Redis both answer, 503 otherwise (body names
the failing check, never details). Only a 2xx counts as healthy. HEALTH_PATH overrides the path.
"""

import os
import sys
import urllib.error
import urllib.request

path = os.environ.get("HEALTH_PATH", "/health")
host = os.environ.get("ALLOWED_HOSTS", "localhost").split(",")[0].strip().lstrip(".")
request = urllib.request.Request(
    f"http://127.0.0.1:8000{path}",
    headers={"Host": host, "X-Forwarded-Proto": "https", "X-Forwarded-For": "127.0.0.1"},
)
try:
    status = urllib.request.urlopen(request, timeout=4).status
except urllib.error.HTTPError as error:
    status = error.code
except OSError as error:
    print(f"unhealthy: {error}", file=sys.stderr)
    sys.exit(1)
sys.exit(0 if 200 <= status < 300 else 1)
