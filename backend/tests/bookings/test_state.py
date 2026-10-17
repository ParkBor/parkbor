"""State table (ARCHITECTURE 6.2): pure, no DB."""

import pytest

from apps.bookings import state
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import InvalidTransition

ALL = list(S)

ALLOWED = {
    (S.PENDING_PAYMENT, S.CONFIRMED),
    (S.PENDING_PAYMENT, S.EXPIRED),
    (S.PENDING_PAYMENT, S.CANCELLED),
    (S.CONFIRMED, S.ACTIVE),
    (S.CONFIRMED, S.CANCELLED),
    (S.CONFIRMED, S.NO_SHOW),
    (S.ACTIVE, S.COMPLETED),
    (S.ACTIVE, S.OVERSTAY),
    (S.OVERSTAY, S.COMPLETED),
}


@pytest.mark.parametrize(
    ("source", "target"), [(a, b) for a in ALL for b in ALL], ids=lambda s: str(s.value)
)
def test_every_pair_matches_the_diagram(source, target):
    assert state.can_transition(source, target) is ((source, target) in ALLOWED)


@pytest.mark.parametrize(
    "terminal", [S.EXPIRED, S.CANCELLED, S.NO_SHOW, S.COMPLETED], ids=lambda s: s.value
)
def test_terminal_states_have_no_exit(terminal):
    assert state.TRANSITIONS[terminal] == frozenset()
    assert terminal in state.TERMINAL_STATUSES


def test_assert_transition_raises_409_invalid_transition():
    with pytest.raises(InvalidTransition) as info:
        state.assert_transition(S.COMPLETED, S.ACTIVE)
    assert info.value.status_code == 409
    assert info.value.get_codes()["code"] == "invalid_transition"


def test_assert_transition_accepts_valid():
    state.assert_transition(S.CONFIRMED, S.ACTIVE)


def test_blocking_statuses_are_those_of_the_exclude_constraint():
    assert set(state.BLOCKING_STATUSES) == {
        S.PENDING_PAYMENT,
        S.CONFIRMED,
        S.ACTIVE,
        S.OVERSTAY,
    }


def test_status_write_guard_is_off_by_default_and_scoped():
    assert not state.status_write_is_allowed()
    with state.status_write_allowed():
        assert state.status_write_is_allowed()
    assert not state.status_write_is_allowed()


def test_status_write_guard_resets_after_exception():
    with pytest.raises(RuntimeError), state.status_write_allowed():
        raise RuntimeError
    assert not state.status_write_is_allowed()
