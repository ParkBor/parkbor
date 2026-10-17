"""Slot choice (ARCHITECTURE 10.4): best-fit gap, then distance to entrance. Pure."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from apps.bookings.allocation import GAP_LOOKBACK, SlotCandidate, pick_slot, rank_slots

START = datetime(2026, 10, 15, 14, tzinfo=ZoneInfo("Asia/Tashkent"))


def cand(slot_id, distance=0, code=None):
    return SlotCandidate(id=slot_id, distance_to_entrance=distance, code=code or slot_id)


def test_smallest_gap_before_start_wins():
    candidates = [cand("a", 1), cand("b", 50), cand("c", 5)]
    ends = {"a": START - timedelta(hours=5), "b": START - timedelta(minutes=10)}
    assert rank_slots(candidates, ends, START)[0] == "b"


def test_slot_without_earlier_booking_has_the_largest_gap():
    candidates = [cand("empty", 1), cand("busy", 99)]
    ends = {"busy": START - timedelta(hours=1)}
    assert rank_slots(candidates, ends, START) == ["busy", "empty"]


def test_equal_gap_prefers_closer_to_entrance():
    candidates = [cand("far", 80), cand("near", 3)]
    ends = {"far": START - timedelta(hours=1), "near": START - timedelta(hours=1)}
    assert rank_slots(candidates, ends, START) == ["near", "far"]


def test_full_tie_is_deterministic_by_code_then_id():
    candidates = [cand("2", 5, "B-2"), cand("1", 5, "B-1")]
    assert rank_slots(candidates, {}, START) == ["1", "2"]


def test_gap_is_capped_by_the_lookback():
    candidates = [cand("old", 9), cand("none", 1)]
    ends = {"old": START - GAP_LOOKBACK - timedelta(days=3)}
    # both count as "a full lookback of free time" -> entrance distance decides
    assert rank_slots(candidates, ends, START) == ["none", "old"]


def test_back_to_back_booking_has_zero_gap():
    candidates = [cand("x", 99), cand("y", 1)]
    assert rank_slots(candidates, {"x": START}, START)[0] == "x"


def test_preferred_slot_is_used_only_if_it_is_a_candidate():
    candidates = [cand("a"), cand("b")]
    assert rank_slots(candidates, {}, START, preferred_slot_id="b") == ["b"]
    assert rank_slots(candidates, {}, START, preferred_slot_id="zzz") == []


def test_pick_slot_returns_best_or_none():
    assert pick_slot([cand("a", 5), cand("b", 1)], {}, START) == "b"
    assert pick_slot([], {}, START) is None
    assert pick_slot([cand("a")], {}, START, preferred_slot_id="nope") is None


def test_input_is_not_mutated():
    candidates = [cand("b", 2), cand("a", 1)]
    snapshot = list(candidates)
    rank_slots(candidates, {}, START)
    assert candidates == snapshot
