"""Pure validation helpers (no DB, no GDAL)."""

import re
from decimal import Decimal, InvalidOperation

MAX_BULK_SLOTS = 500
MAX_SLOT_NUMBER = 99999
MAX_CODE_LENGTH = 20  # Slot.code column size
MAX_COEFFICIENTS = 50
MAX_COEFFICIENT = Decimal("10")
MAX_COEFFICIENT_DECIMALS = 4
MAX_DISTANCE_TO_ENTRANCE = 100_000  # metres
MINUTES_PER_DAY = 24 * 60
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_PREFIX = re.compile(r"^[A-Za-z0-9]{1,10}$")


class RulesError(ValueError):
    pass


def validate_tariff_rules(rules) -> dict:
    """Validate and normalise tariff rules; returns a NEW dict (input is never mutated).

    Shape: {"coefficients": [{"days": [0-6], "from": "HH:MM", "to": "HH:MM",
    "coefficient": "1.5"}]}. ``days`` defaults to all days; ``from``/``to`` come together (an
    overnight range such as 22:00-06:00 is allowed); coefficients are Decimal strings; rules must
    not overlap in time.
    """
    if rules in (None, {}):
        return {}
    if not isinstance(rules, dict):
        raise RulesError("rules must be an object")
    unknown = set(rules) - {"coefficients"}
    if unknown:
        raise RulesError(f"unknown keys: {sorted(unknown)}")
    items = rules.get("coefficients", [])
    if not isinstance(items, list):
        raise RulesError("coefficients must be a list")
    if len(items) > MAX_COEFFICIENTS:
        raise RulesError(f"at most {MAX_COEFFICIENTS} coefficients")
    normalised = [_normalise_coefficient(item) for item in items]
    _reject_overlaps(normalised)
    return {"coefficients": normalised}


def _minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def _normalise_coefficient(item) -> dict:
    if not isinstance(item, dict):
        raise RulesError("each coefficient must be an object")
    days = item.get("days", list(range(7)))
    if (
        not isinstance(days, list)
        or not days
        or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days)
    ):
        raise RulesError("days must be a non-empty list of 0..6 (Mon=0)")
    if len(set(days)) != len(days):
        raise RulesError("duplicate days")
    has_from, has_to = "from" in item, "to" in item
    if has_from != has_to:
        raise RulesError("from and to must be given together")
    for key in ("from", "to"):
        if key in item and not (isinstance(item[key], str) and _HHMM.match(item[key])):
            raise RulesError(f"{key} must be HH:MM")
    if has_from and item["from"] == item["to"]:
        raise RulesError("from and to must differ")
    result = {"days": sorted(days), "coefficient": _coefficient_string(item.get("coefficient"))}
    if has_from:
        result["from"], result["to"] = item["from"], item["to"]
    return result


def _coefficient_string(raw) -> str:
    if raw is None or isinstance(raw, bool):
        raise RulesError("coefficient is required and must be numeric")
    try:
        value = Decimal(str(raw))
    except InvalidOperation as exc:
        raise RulesError("coefficient is required and must be numeric") from exc
    if not value.is_finite() or not 0 < value <= MAX_COEFFICIENT:
        raise RulesError(f"coefficient must be in (0, {MAX_COEFFICIENT}]")
    if value != value.quantize(Decimal(1).scaleb(-MAX_COEFFICIENT_DECIMALS)):
        raise RulesError(f"coefficient allows at most {MAX_COEFFICIENT_DECIMALS} decimals")
    return format(value.normalize(), "f")


def _segments(item: dict) -> list[tuple[int, int, int]]:
    """(day, start_minute, end_minute) pieces covered by a rule; overnight spills to next day."""
    pieces = []
    for day in item["days"]:
        if "from" not in item:
            pieces.append((day, 0, MINUTES_PER_DAY))
            continue
        start, end = _minutes(item["from"]), _minutes(item["to"])
        if start < end:
            pieces.append((day, start, end))
        else:
            pieces.append((day, start, MINUTES_PER_DAY))
            pieces.append(((day + 1) % 7, 0, end))
    return pieces


def _reject_overlaps(items: list[dict]) -> None:
    seen: list[tuple[int, int, int]] = []
    for item in items:
        for day, start, end in _segments(item):
            for other_day, other_start, other_end in seen:
                if day == other_day and start < other_end and other_start < end:
                    raise RulesError("coefficient time ranges overlap")
        seen.extend(_segments(item))


def generate_slot_codes(prefix: str, start: int, end: int) -> list[str]:
    """['A-1', ..., 'A-50'] for prefix 'A', start 1, end 50 (inclusive)."""
    if not _PREFIX.match(prefix or ""):
        raise ValueError("prefix must be 1-10 alphanumeric characters")
    if start < 1 or end < start:
        raise ValueError("range must satisfy 1 <= start <= end")
    if end > MAX_SLOT_NUMBER:
        raise ValueError(f"end must be at most {MAX_SLOT_NUMBER}")
    if end - start + 1 > MAX_BULK_SLOTS:
        raise ValueError(f"at most {MAX_BULK_SLOTS} slots per request")
    codes = [f"{prefix}-{n}" for n in range(start, end + 1)]
    if max(len(code) for code in codes) > MAX_CODE_LENGTH:
        raise ValueError(f"codes must be at most {MAX_CODE_LENGTH} characters")
    return codes
