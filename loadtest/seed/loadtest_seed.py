"""Seed data + JWTs for the k6 load tests (loadtest/README.md).

Run it INSIDE the backend environment of the target stack (it needs the same database and the
same JWT_SIGNING_KEY as the server under test), from the backend directory:

    cd backend
    HABI_LOADTEST_SEED=1 python ../loadtest/seed/loadtest_seed.py \
        --drivers 600 --out ../loadtest/.secrets/tokens.json

It uses the project's own models and writes nothing the services would refuse in staging:
  * driver / owner / operator accounts (telegram_id from a reserved range, role set directly),
    each driver with one vehicle,
  * one fresh ACTIVE lot per purpose (contention, payments, websocket, operator gate),
  * CONFIRMED bookings for the operator gate (start in `--scan-start-in` minutes, so the check-in
    window is open),
  * long-lived access tokens (JWT, `--token-hours`) so a run is not cut off by the 15 min expiry.

SAFETY: refuses to run without HABI_LOADTEST_SEED=1. It refuses a non-DEBUG settings module
unless HABI_LOADTEST_ALLOW_NONDEBUG=1 (needed for staging). Never run it against production: it
mints tokens for real user rows. The output file contains live bearer tokens: it lives in
loadtest/.secrets/ (git-ignored); delete it after the run.
"""

import argparse
import json
import os
import sys
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

BACKEND = Path(os.environ.get("HABI_BACKEND_DIR", Path(__file__).resolve().parents[2] / "backend"))
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.db import transaction  # noqa: E402
from django.utils import timezone  # noqa: E402
from rest_framework_simplejwt.tokens import AccessToken  # noqa: E402

from apps.bookings import qr  # noqa: E402
from apps.bookings.fields import make_period  # noqa: E402
from apps.bookings.models import Booking  # noqa: E402
from apps.bookings.state import BookingStatus, status_write_allowed  # noqa: E402
from apps.core.geo import make_point  # noqa: E402
from apps.parking.models import (  # noqa: E402
    LotStatus,
    OperatorAssignment,
    ParkingLot,
    Slot,
    SlotType,
    Tariff,
    Zone,
)
from apps.parking.services import recalculate_counters  # noqa: E402
from apps.vehicles.models import Vehicle  # noqa: E402

User = get_user_model()
DRIVER_BASE, OWNER_ID, OPERATOR_BASE = 9_100_000_000, 9_000_000_001, 9_200_000_000
TASHKENT = (41.3111, 69.2797)
PRICE = Decimal("6000")


def parse_args():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--drivers", type=int, default=600, help="driver accounts (1 vehicle each)")
    p.add_argument("--operators", type=int, default=5)
    p.add_argument("--contention-slots", type=int, default=1)
    p.add_argument("--payment-slots", type=int, default=400)
    p.add_argument("--ws-lots", type=int, default=3)
    p.add_argument("--scans", type=int, default=100, help="CONFIRMED bookings for the gate test")
    p.add_argument("--scan-start-in", type=int, default=15, help="minutes until scan bookings start")
    p.add_argument("--token-hours", type=int, default=6)
    p.add_argument("--tag", default=timezone.now().strftime("%m%d%H%M"), help="lot name suffix")
    p.add_argument("--out", required=True)
    return p.parse_args()


def guard():
    if os.environ.get("HABI_LOADTEST_SEED") != "1":
        sys.exit("Refusing: set HABI_LOADTEST_SEED=1 to confirm this is NOT production.")
    if not settings.DEBUG and os.environ.get("HABI_LOADTEST_ALLOW_NONDEBUG") != "1":
        sys.exit("Refusing: DEBUG is off. For staging also set HABI_LOADTEST_ALLOW_NONDEBUG=1.")


def user(telegram_id, role, name):
    existing = User.objects.filter(telegram_id=telegram_id).first()
    if existing:
        return existing
    return User.objects.create_user(telegram_id=telegram_id, role=role, first_name=name)


def token_for(account, hours):
    token = AccessToken.for_user(account)
    token.set_exp(lifetime=timedelta(hours=hours))
    return str(token)


def make_lot(owner, name, slots, jitter=0.0):
    lot = ParkingLot.objects.create(
        owner=owner,
        name=name,
        address="Load test, Tashkent",
        location=make_point(TASHKENT[1] + jitter, TASHKENT[0] + jitter),
        status=LotStatus.ACTIVE,
    )
    zone = Zone.objects.create(parking_lot=lot, name="A", floor=1)
    Slot.objects.bulk_create(
        [
            Slot(
                zone=zone,
                code=f"LT-{n}",
                type=SlotType.STANDARD,
                distance_to_entrance=n,
                status="FREE",
            )
            for n in range(1, slots + 1)
        ]
    )
    Tariff.objects.create(parking_lot=lot, slot_type=SlotType.STANDARD, price_per_hour=PRICE)
    recalculate_counters(lot)
    return lot


def make_driver(index, hours):
    account = user(DRIVER_BASE + index, User.Role.DRIVER, f"LT{index}")
    plate = f"LT{index:05d}AB"
    vehicle = Vehicle.objects.filter(user=account, plate_number=plate).first()
    vehicle = vehicle or Vehicle.objects.create(user=account, plate_number=plate, type="CAR")
    return account, {
        "token": token_for(account, hours),
        "vehicle_id": str(vehicle.pk),
        "user_id": str(account.pk),
    }


def scan_bookings(lot, drivers, accounts, vehicles, count, start_in):
    start = timezone.now().replace(second=0, microsecond=0) + timedelta(minutes=start_in)
    end = start + timedelta(hours=2)
    slots = list(Slot.objects.filter(zone__parking_lot=lot).order_by("code")[:count])
    result = []
    with status_write_allowed():
        for index, slot in enumerate(slots):
            booking = Booking.objects.create(
                user=accounts[index],
                slot=slot,
                vehicle=vehicles[index],
                vehicle_plate=vehicles[index].plate_number,
                period=make_period(start, end),
                status=BookingStatus.CONFIRMED,
                amount=Decimal("12000"),
                paid_amount=Decimal("12000"),
                qr_nonce=qr.new_nonce(),
            )
            result.append(
                {"booking_id": str(booking.pk), "driver_token": drivers[index]["token"]}
            )
    return result


@transaction.atomic
def main():
    args = parse_args()
    guard()
    owner = user(OWNER_ID, User.Role.OWNER, "LT Owner")

    pairs = [make_driver(i, args.token_hours) for i in range(args.drivers)]
    accounts = [a for a, _ in pairs]
    drivers = [d for _, d in pairs]
    vehicles = [Vehicle.objects.get(pk=d["vehicle_id"]) for d in drivers]

    contention = make_lot(owner, f"LT-contention-{args.tag}", args.contention_slots)
    payments = make_lot(owner, f"LT-payments-{args.tag}", args.payment_slots, 0.01)
    ws_lots = [
        make_lot(owner, f"LT-ws{n}-{args.tag}", 20, 0.02 + n / 100) for n in range(args.ws_lots)
    ]
    gate = make_lot(owner, f"LT-gate-{args.tag}", args.scans, 0.05)

    operators = []
    for index in range(args.operators):
        account = user(OPERATOR_BASE + index, User.Role.OPERATOR, f"LT Op{index}")
        if not OperatorAssignment.objects.filter(
            operator=account, parking_lot=gate, revoked_at__isnull=True
        ).exists():
            OperatorAssignment.objects.create(operator=account, parking_lot=gate, created_by=owner)
        operators.append({"token": token_for(account, args.token_hours)})

    scan_count = min(args.scans, len(drivers))
    seed = {
        "meta": {"tag": args.tag, "created": timezone.now().isoformat(), "drivers": len(drivers)},
        "drivers": drivers,
        "nearby": {"lat": TASHKENT[0], "lng": TASHKENT[1]},
        "contention": {
            "lot_id": str(contention.pk),
            "slot_type": "STANDARD",
            "slots": args.contention_slots,
        },
        "payments_lot": {"lot_id": str(payments.pk), "slot_type": "STANDARD"},
        "ws": {"lot_ids": [str(lot.pk) for lot in ws_lots], "slot_type": "STANDARD"},
        "operator": {
            "lot_id": str(gate.pk),
            "operators": operators,
            "scans": scan_bookings(
                gate, drivers, accounts, vehicles, scan_count, args.scan_start_in
            ),
        },
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(seed, indent=1))
    try:
        out.chmod(0o600)
    except OSError:
        pass
    print(f"wrote {out}: {len(drivers)} drivers, {len(operators)} operators, 4 lot groups")
    print(f"gate bookings start in {args.scan_start_in} min: run operator_scan_burst.js now.")


if __name__ == "__main__":
    main()
