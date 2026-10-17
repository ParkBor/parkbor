"""Pricing of time parked past a booking's end, and of a walk-in's whole stay (Step 9).

* Overstay (10.7): the time after ``period.end`` is billed at the tariff in started 15-minute
  blocks (``BOOKING_ROUNDING_MINUTES``), with NO free window, times the dynamic factor of the
  lot's occupancy right now. A single second late already costs one block.
* Walk-in: the whole stay, like a booking of that length: the first ``BOOKING_FREE_MINUTES`` free,
  then started blocks, same coefficients and dynamic factor.

Which tariff: the one frozen into the booking when it was made (``Booking.tariff_snapshot``), so a
later price change cannot reprice a stay that began under the old one; bookings without a
snapshot (older rows) use the lot's current tariff. A snapshot that cannot be read (damaged data)
falls back to the current tariff and the charge is flagged for review. A missing tariff never
traps a car: the fee is 0 and the charge says so (``no_tariff``).

Every charge that an administrator should look at (``needs_review``: it hit a limit, had no
tariff, or used damaged terms) is stored on the booking (``overstay_needs_review``); such a charge
is never marked collected on the operator's word alone (see checkout).

Bounds: a forgotten car is billed for at most ``BOOKING_OVERSTAY_MAX_DAYS`` and the amount is
capped to what the money column holds.

The leaving car's own slot is left out of the occupancy used for the dynamic factor: a car that
is just leaving must not make its own exit dearer (unless its slot is out of service and so was
never counted).
"""

import logging
import math
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation

from django.conf import settings

from apps.parking.models import SlotStatus, Tariff

from . import selectors
from .conf import BookingConfig
from .pricing import calc_price

logger = logging.getLogger(__name__)

ZERO = Decimal("0.00")
MAX_AMOUNT = Decimal("9999999999.99")  # DecimalField(max_digits=12, decimal_places=2)
MAX_STORED_MINUTES = 5_000_000  # PositiveIntegerField headroom; ~9 years
SECONDS_PER_MINUTE = 60
MINUTES_PER_DAY = 24 * 60
_BAD_TERMS = (InvalidOperation, KeyError, TypeError, ValueError, AttributeError, ArithmeticError)


@dataclass(frozen=True)
class Charge:
    minutes: int  # started minutes (what the booking records), before any cap
    amount: Decimal
    no_tariff: bool = False  # no tariff to price with: amount is 0
    capped: bool = False  # the time or the amount hit a limit
    bad_terms: bool = False  # damaged tariff data: priced with the current tariff, or 0

    @property
    def needs_review(self) -> bool:
        return self.no_tariff or self.capped or self.bad_terms


def started_minutes(start: datetime, end: datetime) -> int:
    """Whole minutes from `start` to `end`, a started minute counting as a full one."""
    seconds = (end - start).total_seconds()
    return 0 if seconds <= 0 else math.ceil(seconds / SECONDS_PER_MINUTE)


def occupancy_now(lot_id, slot, now: datetime, cfg: BookingConfig) -> Decimal:
    """Share of the lot's working slots of this type that cannot take a car right now, not
    counting the car that is leaving (`slot` is its slot)."""
    window = timedelta(minutes=cfg.pricing.block_minutes)
    total, free = selectors.count_availability(
        lot_id, slot.type, now, now + window, now=now, immediate_window=cfg.immediate_window
    )
    if total == 0:
        return Decimal(0)
    own = (
        0 if slot.status == SlotStatus.OUT_OF_SERVICE else 1
    )  # an out-of-service slot was never counted
    return Decimal(max(total - free - own, 0)) / Decimal(total)


def _snapshot_terms(snapshot) -> tuple[Decimal, dict]:
    price = Decimal(str(snapshot["price_per_hour"]))
    rules = snapshot.get("rules") or {}
    if not price.is_finite() or price < 0 or not isinstance(rules, dict):
        raise ValueError("unusable tariff snapshot")
    return price, rules


def _terms(booking, lot_id, slot_type: str) -> tuple[tuple[Decimal, dict] | None, bool]:
    """((price per hour, coefficient rules) or None, was the snapshot unusable?)."""
    bad = False
    if booking.tariff_snapshot:
        try:
            return _snapshot_terms(booking.tariff_snapshot), False
        except _BAD_TERMS:
            logger.error(
                "booking %s: unreadable tariff snapshot, using the current tariff", booking.pk
            )
            bad = True
    tariff = Tariff.objects.filter(parking_lot_id=lot_id, slot_type=slot_type).first()
    return (None if tariff is None else (tariff.price_per_hour, tariff.rules)), bad


@dataclass(frozen=True)
class _Stay:
    """The stay being priced: whose tariff, where, and from when."""

    booking: object
    lot_id: object
    slot_type: str
    start: datetime


def _price(stay: _Stay, minutes: int, occupancy: Decimal, config) -> Charge:
    max_minutes = settings.BOOKING_OVERSTAY_MAX_DAYS * MINUTES_PER_DAY
    billed = min(minutes, max_minutes)
    shown = min(minutes, MAX_STORED_MINUTES)
    terms, bad = _terms(stay.booking, stay.lot_id, stay.slot_type)
    if terms is None:
        logger.warning("no tariff for lot %s / %s: gate charge is 0", stay.lot_id, stay.slot_type)
        return Charge(shown, ZERO, no_tariff=True, bad_terms=bad)
    price_per_hour, rules = terms
    try:
        total = calc_price(
            price_per_hour=price_per_hour,
            rules=rules,
            start=stay.start,
            end=stay.start + timedelta(minutes=billed),
            occupancy=occupancy,
            config=config,
        ).total
    except _BAD_TERMS:  # damaged coefficient rules: never trap the car, let a person decide
        logger.exception("booking %s: tariff rules could not be applied", stay.booking.pk)
        return Charge(shown, ZERO, bad_terms=True)
    capped = billed < minutes or total > MAX_AMOUNT
    return Charge(shown, min(total, MAX_AMOUNT), capped=capped, bad_terms=bad)


def price_overstay(booking, lot_id, slot, now: datetime, cfg: BookingConfig) -> Charge:
    """Charge for the started minutes past the booking end."""
    minutes = started_minutes(booking.ends_at, now)
    if minutes == 0:
        return Charge(0, ZERO)
    occupancy = occupancy_now(lot_id, slot, now, cfg)
    config = replace(cfg.pricing, free_minutes=0)
    return _price(_Stay(booking, lot_id, slot.type, booking.ends_at), minutes, occupancy, config)


def price_walk_in(booking, lot_id, slot, now: datetime, cfg: BookingConfig) -> Charge:
    """Charge for a walk-in that leaves at `now` (the whole stay; the first minutes are free)."""
    start = booking.checked_in_at or booking.starts_at
    minutes = started_minutes(start, now)
    if minutes == 0:
        return Charge(0, ZERO)
    occupancy = occupancy_now(lot_id, slot, now, cfg)
    return _price(_Stay(booking, lot_id, slot.type, start), minutes, occupancy, cfg.pricing)
