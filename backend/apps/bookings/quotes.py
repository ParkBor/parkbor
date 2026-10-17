"""Read-only price and availability quotes (no locks, no writes, COUNT queries only)."""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from django.utils import timezone

from apps.core.exceptions import NotFoundError
from apps.parking.models import LotStatus, ParkingLot, Tariff

from . import selectors
from .conf import get_config
from .errors import rule_violation
from .hours import fits_working_hours
from .periods import validate_period
from .pricing import PriceQuote, calc_price


@dataclass(frozen=True)
class PriceResult:
    quote: PriceQuote
    available: int


@dataclass(frozen=True)
class AvailabilityResult:
    slot_type: str | None
    start: datetime
    end: datetime
    total: int
    available: int
    is_open: bool


def require_tariff(lot_id, slot_type) -> Tariff:
    tariff = Tariff.objects.filter(parking_lot_id=lot_id, slot_type=slot_type).first()
    if tariff is None:
        raise rule_violation("no_tariff", "This parking lot has no tariff for this slot type.")
    return tariff


def active_lot_for_read(lot_id) -> ParkingLot:
    lot = ParkingLot.objects.filter(pk=lot_id, status=LotStatus.ACTIVE).first()
    if lot is None:
        raise NotFoundError("Parking lot not found.")
    return lot


def _occupancy(total: int, free: int) -> Decimal:
    return Decimal(0) if total == 0 else Decimal(total - free) / Decimal(total)


def quote_price(
    *, lot_id, slot_type: str, start: datetime, end: datetime, now: datetime | None = None
) -> PriceResult:
    """Indicative price of a period (what a booking created right now would cost)."""
    now = now or timezone.now()
    cfg = get_config()
    lot = active_lot_for_read(lot_id)
    start, end = validate_period(lot=lot, start=start, end=end, now=now, cfg=cfg)
    tariff = require_tariff(lot.pk, slot_type)
    total, free = selectors.count_availability(
        lot.pk, slot_type, start, end, now=now, immediate_window=cfg.immediate_window
    )
    quote = calc_price(
        price_per_hour=tariff.price_per_hour,
        rules=tariff.rules,
        start=start,
        end=end,
        occupancy=_occupancy(total, free),
        config=cfg.pricing,
    )
    return PriceResult(quote=quote, available=free)


def get_availability(
    *,
    lot_id,
    slot_type: str | None,
    start: datetime,
    end: datetime,
    now: datetime | None = None,
) -> AvailabilityResult:
    """Free slots in ``[start, end)``: working slots - slots with a live overlapping booking."""
    now = now or timezone.now()
    cfg = get_config()
    lot = active_lot_for_read(lot_id)
    start, end = validate_period(lot=lot, start=start, end=end, now=now, cfg=cfg, check_hours=False)
    is_open = fits_working_hours(lot.open_time, lot.close_time, start, end)
    total, free = selectors.count_availability(
        lot.pk, slot_type, start, end, now=now, immediate_window=cfg.immediate_window
    )
    return AvailabilityResult(
        slot_type=slot_type,
        start=start,
        end=end,
        total=total,
        available=free if is_open else 0,
        is_open=is_open,
    )
