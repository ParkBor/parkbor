"""Vehicle type <-> slot type compatibility (ARCHITECTURE 10.4 rule 3)."""

import pytest

from apps.bookings.compat import is_compatible

CASES = [
    ("CAR", "STANDARD", True),
    ("CAR", "EV", False),
    ("CAR", "DISABLED", False),
    ("CAR", "LARGE", False),
    ("TRUCK", "LARGE", True),
    ("TRUCK", "STANDARD", False),
    ("TRUCK", "EV", False),
    ("EV", "EV", True),
    ("EV", "STANDARD", True),
    ("EV", "DISABLED", False),
    ("EV", "LARGE", False),
    ("DISABLED", "DISABLED", True),
    ("DISABLED", "STANDARD", True),
    ("DISABLED", "EV", False),
    ("DISABLED", "LARGE", False),
]


@pytest.mark.parametrize(("vehicle", "slot", "expected"), CASES)
def test_matrix(vehicle, slot, expected):
    assert is_compatible(vehicle, slot) is expected


def test_unknown_vehicle_type_is_incompatible():
    assert not is_compatible("BIKE", "STANDARD")
