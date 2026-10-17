"""Price calculation (ARCHITECTURE 10.5). Pure functions, Decimal only, no DB.

Model
-----
* The first ``free_minutes`` of a booking are free; the rest is billed in blocks of
  ``block_minutes`` (rounded UP). Blocks start at the booking start and run back to back.
* Each block is priced ``price_per_hour * block/60 * coefficient`` where the coefficient is the
  tariff rule matching the block's START instant in Asia/Tashkent (weekday + time of day;
  overnight ranges such as 22:00-06:00 belong to the weekday on which they start).
* Consecutive blocks with the same coefficient are reported as one segment.
* ``subtotal`` (sum of segments) is multiplied by the dynamic occupancy factor ``k_band``.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from apps.parking.ranking import LOCAL_TZ

CENT = Decimal("0.01")
FACTOR_PLACES = Decimal("0.0001")
ONE = Decimal(1)
MINUTES_PER_HOUR = Decimal(60)
# One quote never walks more blocks than this (a year of 15-minute blocks is 35 040): callers cap
# the period first; this keeps a bug or a hostile input from looping for ever.
MAX_BLOCKS = 40_000


@dataclass(frozen=True)
class PricingConfig:
    free_minutes: int = 10
    block_minutes: int = 15
    dynamic_threshold: Decimal = Decimal("0.8")
    dynamic_slope: Decimal = Decimal("0.5")
    dynamic_max: Decimal = Decimal("1.5")


@dataclass(frozen=True)
class PriceSegment:
    start: datetime
    end: datetime
    minutes: int
    coefficient: Decimal
    amount: Decimal


@dataclass(frozen=True)
class PriceQuote:
    price_per_hour: Decimal
    total_minutes: int
    free_minutes: int
    billed_minutes: int
    segments: tuple[PriceSegment, ...]
    subtotal: Decimal
    occupancy: Decimal | None
    dynamic_factor: Decimal
    total: Decimal


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def dynamic_factor(occupancy: Decimal | None, config: PricingConfig) -> Decimal:
    """``k_band``: 1 up to the threshold, then ``1 + slope * (occupancy - threshold)``, capped."""
    if occupancy is None:
        return ONE
    occupancy = min(max(occupancy, Decimal(0)), ONE)
    if occupancy <= config.dynamic_threshold:
        return ONE
    raw = ONE + config.dynamic_slope * (occupancy - config.dynamic_threshold)
    return min(raw, config.dynamic_max).quantize(FACTOR_PLACES, rounding=ROUND_HALF_UP).normalize()


def _hhmm(value: str) -> int:
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def _rule_matches(rule: dict, local: datetime) -> bool:
    """Does `rule` cover the local instant? (``days`` = weekdays on which the range STARTS.)"""
    days = rule.get("days", range(7))
    if "from" not in rule:
        return local.weekday() in days
    start, end = _hhmm(rule["from"]), _hhmm(rule["to"])
    minute = local.hour * 60 + local.minute
    if start < end:
        return local.weekday() in days and start <= minute < end
    if minute >= start:  # evening part, same weekday
        return local.weekday() in days
    return minute < end and (local.weekday() - 1) % 7 in days  # after midnight: previous day


def coefficient_at(rules: dict | None, instant: datetime) -> Decimal:
    """Time/day coefficient (``Tariff.rules``) at `instant`; 1 when no rule matches."""
    local = instant.astimezone(LOCAL_TZ)
    for rule in (rules or {}).get("coefficients", []):
        if _rule_matches(rule, local):
            return Decimal(rule["coefficient"])
    return ONE


def _block_count(total_minutes: int, config: PricingConfig) -> int:
    billable = max(total_minutes - config.free_minutes, 0)
    return -(-billable // config.block_minutes)  # ceiling division


def _segments(
    *, price_per_hour: Decimal, rules, start: datetime, blocks: int, config: PricingConfig
) -> tuple[PriceSegment, ...]:
    block_price = price_per_hour * Decimal(config.block_minutes) / MINUTES_PER_HOUR
    groups: list[list] = []  # [coefficient, first block start, block count]
    for index in range(blocks):
        block_start = start + timedelta(minutes=index * config.block_minutes)
        coefficient = coefficient_at(rules, block_start)
        if groups and groups[-1][0] == coefficient:
            groups[-1][2] += 1
        else:
            groups.append([coefficient, block_start, 1])
    return tuple(
        PriceSegment(
            start=first,
            end=first + timedelta(minutes=count * config.block_minutes),
            minutes=count * config.block_minutes,
            coefficient=coefficient,
            amount=_money(block_price * count * coefficient),
        )
        for coefficient, first, count in groups
    )


def calc_price(
    *,
    price_per_hour: Decimal,
    rules: dict | None,
    start: datetime,
    end: datetime,
    occupancy: Decimal | None = None,
    config: PricingConfig | None = None,
) -> PriceQuote:
    """Price of the period ``[start, end)``; see the module docstring for the model."""
    config = config or PricingConfig()
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start and end must be timezone-aware")
    if end <= start:
        raise ValueError("end must be after start")
    total_minutes = int((end - start).total_seconds() // 60)
    blocks = _block_count(total_minutes, config)
    if blocks > MAX_BLOCKS:
        raise ValueError(f"a quote may span at most {MAX_BLOCKS} blocks")
    segments = _segments(
        price_per_hour=price_per_hour, rules=rules, start=start, blocks=blocks, config=config
    )
    subtotal = sum((s.amount for s in segments), Decimal(0)).quantize(CENT)
    factor = dynamic_factor(occupancy, config)
    return PriceQuote(
        price_per_hour=price_per_hour,
        total_minutes=total_minutes,
        free_minutes=min(config.free_minutes, total_minutes),
        billed_minutes=blocks * config.block_minutes,
        segments=segments,
        subtotal=subtotal,
        occupancy=occupancy,
        dynamic_factor=factor,
        total=_money(subtotal * factor),
    )
