"""Pure ranking logic for the nearby search (no DB, no network): ARCHITECTURE 10.1c/d.

Everything here is deterministic and testable without GDAL.
"""

from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("Asia/Tashkent")

MIN_RESULTS = 3  # fewer results than this -> widen the radius
MAX_RADIUS_M = 10_000
RADIUS_LADDER_M = (1_000, 3_000, 5_000, 10_000)
CANDIDATE_FACTOR = 3  # M = 3K candidates go to the (expensive) road-time stage

# score = W_TIME*norm(time) + W_PRICE*norm(price) + W_FILL*(1 - free share) - W_RATING*norm(rating)
W_TIME, W_PRICE, W_FILL, W_RATING = 0.5, 0.2, 0.2, 0.1

SORT_CHOICES = ("recommended", "nearest", "cheapest")


@dataclass(frozen=True)
class NearbyQuery:
    lat: float
    lng: float
    radius_m: int
    slot_type: str | None
    limit: int
    sort: str
    only_open: bool


@dataclass(frozen=True)
class NearbyLot:
    """Static facts about a candidate lot (what the cache stores; no per-request values)."""

    id: str
    name: str
    address: str
    lat: float
    lng: float
    free_slots: int
    total_slots: int
    price_per_hour: Decimal | None
    rating: float | None
    open_time: time | None
    close_time: time | None

    def to_json(self) -> dict:
        data = asdict(self)
        data["price_per_hour"] = None if self.price_per_hour is None else str(self.price_per_hour)
        data["open_time"] = self.open_time.isoformat() if self.open_time else None
        data["close_time"] = self.close_time.isoformat() if self.close_time else None
        return data

    @classmethod
    def from_json(cls, data: dict) -> "NearbyLot":
        """Rebuild from `to_json` output; raises (KeyError/TypeError/ValueError) if malformed."""
        price = data["price_per_hour"]
        return cls(
            id=str(data["id"]),
            name=str(data["name"]),
            address=str(data["address"]),
            lat=float(data["lat"]),
            lng=float(data["lng"]),
            free_slots=int(data["free_slots"]),
            total_slots=int(data["total_slots"]),
            price_per_hour=None if price is None else Decimal(price),
            rating=None if data["rating"] is None else float(data["rating"]),
            open_time=time.fromisoformat(data["open_time"]) if data["open_time"] else None,
            close_time=time.fromisoformat(data["close_time"]) if data["close_time"] else None,
        )


@dataclass(frozen=True)
class NearbyResult:
    lot: NearbyLot
    distance_m: float
    duration_s: int | None
    score: float | None
    is_open: bool


@dataclass(frozen=True)
class NearbySearchResult:
    results: list[NearbyResult]
    radius_used_m: int


def is_open_at(open_time: time | None, close_time: time | None, now: time) -> bool:
    """Opening hours check. Missing hours = always open; open == close = 24 h;
    open > close = overnight (e.g. 22:00-06:00). Opening instant inclusive, closing exclusive."""
    if open_time is None or close_time is None or open_time == close_time:
        return True
    if open_time < close_time:
        return open_time <= now < close_time
    return now >= open_time or now < close_time


def is_open_now(open_time: time | None, close_time: time | None, now: datetime) -> bool:
    """Same as `is_open_at` for an aware datetime, evaluated in Asia/Tashkent."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    return is_open_at(open_time, close_time, now.astimezone(LOCAL_TZ).time())


def min_max_norm(values: Sequence[float]) -> list[float]:
    """Scale to 0..1 within the sample; all equal (or empty) -> zeros."""
    if not values:
        return []
    low, high = min(values), max(values)
    if high == low:
        return [0.0] * len(values)
    return [(v - low) / (high - low) for v in values]


def scoring_metric(
    distances_m: Sequence[float], durations_s: Sequence[float | None] | None
) -> list[float]:
    """Road time when every candidate has one; otherwise straight-line distance for all
    (mixing seconds and metres would make the normalisation meaningless)."""
    if durations_s is not None and all(d is not None for d in durations_s):
        return [float(d) for d in durations_s]
    return [float(d) for d in distances_m]


def compute_scores(lots: Sequence[NearbyLot], *, metric: Sequence[float]) -> list[float]:
    """Lower is better. Missing price counts as the worst price, missing rating as 0."""
    if len(lots) != len(metric):
        raise ValueError("metric length must match lots length")
    price_n = _price_norm(lots)
    ratings = [lot.rating or 0.0 for lot in lots]
    time_n, rating_n = min_max_norm(metric), min_max_norm(ratings)
    return [
        W_TIME * time_n[i]
        + W_PRICE * price_n[i]
        + W_FILL * (1 - _free_share(lot))
        - W_RATING * rating_n[i]
        for i, lot in enumerate(lots)
    ]


def _price_norm(lots: Sequence[NearbyLot]) -> list[float]:
    """Min-max over the priced lots only; an unpriced lot gets the worst value (1.0)."""
    priced = [float(lot.price_per_hour) for lot in lots if lot.price_per_hour is not None]
    if not priced:
        return [0.0] * len(lots)
    normalised = iter(min_max_norm(priced))
    return [1.0 if lot.price_per_hour is None else next(normalised) for lot in lots]


def _free_share(lot: NearbyLot) -> float:
    return lot.free_slots / lot.total_slots if lot.total_slots > 0 else 0.0


def sort_results(results: Sequence[NearbyResult], sort: str) -> list[NearbyResult]:
    """Return a new list ordered by the requested mode (stable, deterministic tie-breaks)."""
    if sort == "nearest":
        return sorted(results, key=lambda r: (r.distance_m, r.lot.id))
    if sort == "cheapest":
        return sorted(
            results,
            key=lambda r: (
                r.lot.price_per_hour is None,
                r.lot.price_per_hour or Decimal(0),
                r.distance_m,
                r.lot.id,
            ),
        )
    if sort == "recommended":
        return sorted(
            results,
            key=lambda r: (
                r.score if r.score is not None else float("inf"),
                r.distance_m,
                r.lot.id,
            ),
        )
    raise ValueError(f"unknown sort: {sort!r}")


def expansion_steps(radius_m: int) -> list[int]:
    """Radii to try in order: the requested one, then 1 -> 3 -> 5 -> 10 km steps above it."""
    return [radius_m, *[step for step in RADIUS_LADDER_M if radius_m < step <= MAX_RADIUS_M]]
