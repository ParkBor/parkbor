"""Which slot types a vehicle type may book (ARCHITECTURE 10.4 rule 3).

Special slots (EV charging, disabled, large) are kept for the vehicles that need them. An EV or
a disabled driver may also use a STANDARD slot; a CAR may not take an EV/DISABLED/LARGE one, and
a TRUCK only fits LARGE. (Letting a CAR into a LARGE slot when the lot has no standard ones left
needs an admin setting that does not exist yet.)
"""

VEHICLE_SLOT_TYPES: dict[str, frozenset[str]] = {
    "CAR": frozenset({"STANDARD"}),
    "TRUCK": frozenset({"LARGE"}),
    "EV": frozenset({"EV", "STANDARD"}),
    "DISABLED": frozenset({"DISABLED", "STANDARD"}),
}


def is_compatible(vehicle_type: str, slot_type: str) -> bool:
    return slot_type in VEHICLE_SLOT_TYPES.get(vehicle_type, frozenset())
