"""Seed 30 fictional parking lots around Tashkent for development.

Safe to re-run: lots are matched by (seed owner, name) and left untouched when present.
Refuses to run unless DEBUG is on, so it can never pollute a production database.
"""

from decimal import Decimal

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.core.geo import make_point
from apps.parking import selectors
from apps.parking.models import LotStatus, ParkingLot, Slot, SlotStatus, SlotType, Tariff, Zone
from apps.parking.seed_data import (
    SEED_OWNER_NAME,
    SEED_OWNER_PHONE,
    SEED_OWNER_TELEGRAM_ID,
    LotSpec,
    build_specs,
)
from apps.parking.services import recalculate_counters

# Price multipliers relative to the STANDARD tariff.
TYPE_PRICE_FACTOR = {
    SlotType.EV: Decimal("1.5"),
    SlotType.DISABLED: Decimal("0.5"),
    SlotType.LARGE: Decimal("1.4"),
}
FULL_SHARE = 0.97  # at/above this share every slot (all types) is taken


def _get_owner():
    User = get_user_model()
    owner = User.objects.filter(telegram_id=SEED_OWNER_TELEGRAM_ID).first()
    if owner is None:
        # phone is unique: never fail (or take over a real number) if someone already has it
        phone = None if User.objects.filter(phone=SEED_OWNER_PHONE).exists() else SEED_OWNER_PHONE
        owner = User.objects.create_user(
            SEED_OWNER_TELEGRAM_ID,
            role=User.Role.OWNER,
            phone=phone,
            first_name=SEED_OWNER_NAME,
        )
    return owner


def _slot_plan(spec: LotSpec) -> list[tuple[str, str, int]]:
    """[(code prefix, slot type, count)] in a stable order."""
    plan = [("S", SlotType.STANDARD, spec.standard_slots)]
    for prefix, slot_type, count in (
        ("E", SlotType.EV, spec.ev_slots),
        ("D", SlotType.DISABLED, spec.disabled_slots),
        ("L", SlotType.LARGE, spec.large_slots),
    ):
        if count:
            plan.append((prefix, slot_type, count))
    return plan


def _create_lot(owner, spec: LotSpec) -> ParkingLot:
    open_time, close_time = spec.hours if spec.hours else (None, None)
    lot = ParkingLot.objects.create(
        owner=owner,
        name=spec.name,
        address=spec.address,
        location=make_point(spec.lng, spec.lat),
        status=LotStatus.ACTIVE,
        open_time=open_time,
        close_time=close_time,
        rating=spec.rating,
    )
    zone = Zone.objects.create(parking_lot=lot, name="A", floor=0)
    taken_standard = int(spec.occupied_share * spec.standard_slots)
    everything_taken = spec.occupied_share >= FULL_SHARE
    slots = []
    for prefix, slot_type, count in _slot_plan(spec):
        for number in range(1, count + 1):
            occupied = everything_taken or (
                slot_type == SlotType.STANDARD and number <= taken_standard
            )
            slots.append(
                Slot(
                    zone=zone,
                    code=f"{prefix}-{number}",
                    type=slot_type,
                    status=SlotStatus.OCCUPIED if occupied else SlotStatus.FREE,
                    distance_to_entrance=number * 3,
                )
            )
        price = spec.standard_price * TYPE_PRICE_FACTOR.get(slot_type, Decimal(1))
        Tariff.objects.create(
            parking_lot=lot, slot_type=slot_type, price_per_hour=price.quantize(Decimal("0.01"))
        )
    Slot.objects.bulk_create(slots)
    recalculate_counters(lot)
    return lot


class Command(BaseCommand):
    help = "Seed 30 test parking lots in Tashkent (development only; idempotent)."

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError("seed_parkings only runs with DEBUG=True (development).")
        if not getattr(settings, "ALLOW_SEED", False):
            raise CommandError(
                "seed_parkings also needs settings.ALLOW_SEED = True (set only in dev settings)."
            )
        with transaction.atomic():
            owner = _get_owner()
            existing = set(ParkingLot.objects.filter(owner=owner).values_list("name", flat=True))
            created = 0
            for spec in build_specs():
                if spec.name in existing:
                    continue
                _create_lot(owner, spec)
                created += 1
        selectors.analyze_parking_lots()  # fresh statistics for the KNN planner (PostgreSQL only)
        total = ParkingLot.objects.filter(owner=owner).count()
        self.stdout.write(
            self.style.SUCCESS(f"Seeded {created} new lots; {total} seed lots in total.")
        )
