"""Test-only hook server for the Maestro mobile E2E flows (mobile/e2e/README.md).

Real Telegram and the real payment provider cannot be automated, so this process plays their
server-side part against a NON-PRODUCTION stack. Run it INSIDE the backend environment of the stack
under test (same database, same Redis, same JWT/SECRET_KEY as the API), from the backend directory:

    cd backend
    HABI_E2E_HOOK=1 HABI_E2E_HOOK_KEY=<16+ random chars> \
    HABI_E2E_SEED_FILE=../loadtest/.secrets/tokens.json \
    python ../mobile/e2e/helpers/e2e_hook_server.py --port 8765

Endpoints (all POST, JSON in / JSON out, header `X-E2E-Key` required):
  /login-code    {telegram_id, first_name?}  play the Telegram bot: confirm the NEWEST pending app
                                             login and return the 6-digit code -> {code, is_new}
  /pay-latest    {telegram_id}               play the provider webhook for the user's newest
                                             PENDING_PAYMENT booking (register + complete) -> {booking_id}
  /paid-booking  {driver_index, lot, start_in_min?, hours?}
                                             create a booking for seed driver N through the REAL API
                                             and pay it -> {booking_id}.  lot: payments | ws0 | ws1 | ws2
  /qr            {scan_index}                the CURRENT QR token (entry before check-in, exit after)
                                             of the seed gate booking N, read through the real API
                                             -> {qr_token}
  /health        {}                          -> {ok: true}

SAFETY (every one is enforced below):
  * refuses to start without HABI_E2E_HOOK=1 and a key of 16+ characters;
  * refuses a non-DEBUG settings module unless HABI_E2E_ALLOW_NONDEBUG=1 (staging only);
  * binds 127.0.0.1 only; the key is compared in constant time;
  * never put this on a production host: it mints logins for arbitrary telegram ids.
No secret is written to disk or logged (request bodies are not logged).
"""

import argparse
import hmac
import json
import os
import sys
import uuid
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, request

BACKEND = Path(os.environ.get("HABI_BACKEND_DIR", Path(__file__).resolve().parents[3] / "backend"))
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.bookings.models import Booking  # noqa: E402
from apps.bookings.state import BookingStatus  # noqa: E402
from apps.core.redis_client import get_redis  # noqa: E402
from apps.payments import services as payment_services  # noqa: E402
from apps.telegram_bot import login_service  # noqa: E402

MAX_BODY_BYTES = 4096
MIN_KEY_LENGTH = 16
PROVIDER = "payme"
LOTS = {"payments": ("payments_lot", None), "ws0": ("ws", 0), "ws1": ("ws", 1), "ws2": ("ws", 2)}


class HookError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def guard() -> str:
    if os.environ.get("HABI_E2E_HOOK") != "1":
        sys.exit("Refusing: set HABI_E2E_HOOK=1 to confirm this is NOT production.")
    key = os.environ.get("HABI_E2E_HOOK_KEY", "")
    if len(key) < MIN_KEY_LENGTH:
        sys.exit(f"Refusing: HABI_E2E_HOOK_KEY must be at least {MIN_KEY_LENGTH} characters.")
    if not settings.DEBUG and os.environ.get("HABI_E2E_ALLOW_NONDEBUG") != "1":
        sys.exit("Refusing: DEBUG is off. For staging also set HABI_E2E_ALLOW_NONDEBUG=1.")
    return key


def load_seed() -> dict:
    path = os.environ.get("HABI_E2E_SEED_FILE")
    if not path:
        raise HookError(500, "HABI_E2E_SEED_FILE is not set (loadtest_seed.py --out file)")
    return json.loads(Path(path).read_text())


def api_base() -> str:
    return os.environ.get("HABI_E2E_API", "http://127.0.0.1:8000/api/v1").rstrip("/")


def call_api(method: str, path: str, token: str, body: dict | None = None, key: str | None = None):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    data = json.dumps(body).encode() if body is not None else None
    req = request.Request(f"{api_base()}{path}", data=data, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=15) as res:  # noqa: S310 - loopback/staging URL from env
            return json.loads(res.read() or b"{}")
    except error.HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        raise HookError(502, f"API {method} {path} -> {exc.code}: {detail}") from None
    except error.URLError as exc:
        raise HookError(502, f"API unreachable: {exc.reason}") from None


# --- handlers ---------------------------------------------------------------------------------


def newest_pending_token() -> str | None:
    """The pending app login with the most TTL left = the one started last."""
    redis = get_redis()
    best, best_ttl = None, -1
    for redis_key in redis.scan_iter(match="tglogin:*", count=200):
        if redis.hget(redis_key, "status") != login_service.PENDING:
            continue
        ttl = redis.pttl(redis_key)
        if ttl > best_ttl:
            best, best_ttl = redis_key.removeprefix("tglogin:"), ttl
    return best


def login_code(body: dict) -> dict:
    telegram_id = int(body["telegram_id"])
    token = newest_pending_token()
    if token is None:
        raise HookError(409, "no pending app login: tap 'Sign in with Telegram' first")
    from apps.accounts.models import User

    is_new = not User.objects.filter(telegram_id=telegram_id).exists()
    identity = login_service.TelegramIdentity(
        telegram_id=telegram_id,
        phone=f"+998{telegram_id % 10**9:09d}",
        username=f"e2e_{telegram_id}",
        first_name=str(body.get("first_name") or "E2E")[:40],
        last_name="",
    )
    code = login_service.confirm_contact(token, identity)
    if code is None:
        raise HookError(409, "login session expired or already confirmed")
    return {"code": code, "is_new": is_new}


def pay_booking(booking: Booking) -> None:
    external_id = f"e2e-{uuid.uuid4().hex}"
    now = timezone.now()
    payment_services.register_transaction(
        booking_id=booking.pk,
        provider=PROVIDER,
        external_id=external_id,
        amount=booking.amount,
        now=now,
    )
    payment_services.complete_payment(provider=PROVIDER, external_id=external_id, now=timezone.now())


def pay_latest(body: dict) -> dict:
    booking = (
        Booking.objects.filter(
            user__telegram_id=int(body["telegram_id"]), status=BookingStatus.PENDING_PAYMENT
        )
        .order_by("-created_at")
        .first()
    )
    if booking is None:
        raise HookError(404, "no PENDING_PAYMENT booking for this telegram_id")
    pay_booking(booking)
    return {"booking_id": str(booking.pk)}


def iso_minutes(offset_min: int) -> str:
    moment = timezone.now().replace(second=0, microsecond=0) + timedelta(minutes=offset_min)
    return moment.isoformat().replace("+00:00", "Z")


def paid_booking(body: dict) -> dict:
    seed = load_seed()
    driver = seed["drivers"][int(body.get("driver_index", 0))]
    section, index = LOTS[body.get("lot", "payments")]
    lot_id = seed[section]["lot_ids"][index] if index is not None else seed[section]["lot_id"]
    start_in = int(body.get("start_in_min", 180))
    hours = int(body.get("hours", 1))
    created = call_api(
        "POST",
        "/bookings",
        driver["token"],
        {
            "parking_lot_id": lot_id,
            "slot_type": "STANDARD",
            "vehicle_id": driver["vehicle_id"],
            "start": iso_minutes(start_in),
            "end": iso_minutes(start_in + 60 * hours),
            "preferred_slot_id": None,
        },
        key=str(uuid.uuid4()),
    )
    booking = Booking.objects.get(pk=created["id"])
    pay_booking(booking)
    return {"booking_id": str(booking.pk)}


def gate_qr(body: dict) -> dict:
    scan = load_seed()["operator"]["scans"][int(body["scan_index"])]
    result = call_api("GET", f"/bookings/{scan['booking_id']}/qr", scan["driver_token"])
    return {"qr_token": result["qr_token"], "booking_id": scan["booking_id"]}


ROUTES = {
    "/login-code": login_code,
    "/pay-latest": pay_latest,
    "/paid-booking": paid_booking,
    "/qr": gate_qr,
    "/health": lambda _body: {"ok": True},
}


def make_handler(hook_key: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # request lines carry paths only, but stay silent anyway
            return

        def reply(self, status: int, payload: dict) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):  # noqa: N802 - http.server API
            supplied = self.headers.get("X-E2E-Key", "")
            if not hmac.compare_digest(supplied.encode(), hook_key.encode()):
                return self.reply(401, {"error": "bad key"})
            handler = ROUTES.get(self.path)
            if handler is None:
                return self.reply(404, {"error": "unknown route"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_BODY_BYTES:
                    raise HookError(413, "body too large")
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise HookError(400, "JSON object expected")
                return self.reply(200, handler(body))
            except HookError as exc:
                return self.reply(exc.status, {"error": exc.message})
            except (KeyError, ValueError, IndexError, TypeError) as exc:
                return self.reply(400, {"error": f"bad request: {type(exc).__name__}: {exc}"})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    key = guard()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(key))
    print(f"e2e hook server on http://127.0.0.1:{args.port} (DEBUG={settings.DEBUG}). Ctrl+C stops it.")
    server.serve_forever()


if __name__ == "__main__":
    main()
