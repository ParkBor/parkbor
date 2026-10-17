"""Slot choice (ARCHITECTURE 10.4). Pure functions over plain values (no DB).

Best-fit: among free slots take the one whose previous booking ended closest before the new
start (smallest gap), so long free stretches stay intact for long bookings. Ties go to the slot
nearest the entrance, then to code and id for a deterministic result.
"""

from collections.abc import Hashable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

# A slot with no booking in the last day (or none at all) has a "full" gap; looking back further
# would only make the query bigger without changing the ranking in practice.
GAP_LOOKBACK = timedelta(hours=24)


@dataclass(frozen=True)
class SlotCandidate:
    id: Hashable
    distance_to_entrance: int
    code: str


def _gap(previous_end: datetime | None, start: datetime) -> timedelta:
    if previous_end is None or previous_end > start:
        return GAP_LOOKBACK if previous_end is None else timedelta(0)
    return min(start - previous_end, GAP_LOOKBACK)


def rank_slots(
    candidates: Sequence[SlotCandidate],
    previous_ends: Mapping[Hashable, datetime | None],
    start: datetime,
    preferred_slot_id: Hashable | None = None,
) -> list[Hashable]:
    """Candidate ids, best first. With `preferred_slot_id` only that slot (if a candidate)."""
    if preferred_slot_id is not None:
        return [c.id for c in candidates if c.id == preferred_slot_id]
    ordered = sorted(
        candidates,
        key=lambda c: (
            _gap(previous_ends.get(c.id), start),
            c.distance_to_entrance,
            c.code,
            str(c.id),
        ),
    )
    return [c.id for c in ordered]


def pick_slot(
    candidates: Sequence[SlotCandidate],
    previous_ends: Mapping[Hashable, datetime | None],
    start: datetime,
    preferred_slot_id: Hashable | None = None,
) -> Hashable | None:
    ranked = rank_slots(candidates, previous_ends, start, preferred_slot_id)
    return ranked[0] if ranked else None
