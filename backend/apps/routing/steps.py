"""Turn-by-turn step simplification (ARCHITECTURE 10.2): OSRM maneuvers -> stable keys.

The mobile app localises ``instruction_key`` (uz/ru/en); street names are passed through
sanitised (control/format characters removed, length capped) but NOT HTML-escaped: any client
that renders them as HTML (admin panel, WebView) must escape them.
"""

import unicodedata

INSTRUCTION_KEYS = (
    "depart",
    "arrive",
    "turn_left",
    "turn_right",
    "slight_left",
    "slight_right",
    "sharp_left",
    "sharp_right",
    "straight",
    "uturn",
    "roundabout",
    "merge",
    "fork",
    "ramp",
    "continue",
    "other",
    # Side-aware variants of merge/fork/ramp. The plain keys stay valid: they are used when OSRM
    # gives no side (modifier missing or "straight"), so clients should fall back to them.
    "merge_left",
    "merge_right",
    "fork_left",
    "fork_right",
    "ramp_left",
    "ramp_right",
)
MAX_STEPS = 500  # more steps are merged (see _merge_to_cap), never truncated
MAX_NAME_LENGTH = 100
MAX_MANEUVER_LENGTH = 32

_MODIFIER_KEYS = {
    "left": "turn_left",
    "right": "turn_right",
    "slight left": "slight_left",
    "slight right": "slight_right",
    "sharp left": "sharp_left",
    "sharp right": "sharp_right",
    "straight": "straight",
    "uturn": "uturn",
}
# "continue"/"new name" with a plain left/right is a bend of the same road, not a turn.
_CONTINUE_KEYS = {**_MODIFIER_KEYS, "left": "slight_left", "right": "slight_right"}
_FIXED_KEYS = {
    "depart": "depart",
    "arrive": "arrive",
    "roundabout": "roundabout",
    "rotary": "roundabout",
    "roundabout turn": "roundabout",
    "exit roundabout": "roundabout",
    "exit rotary": "roundabout",
}
_SIDED_KINDS = {
    "merge": "merge",
    "fork": "fork",
    "on ramp": "ramp",
    "off ramp": "ramp",
}
_TURN_LIKE = {"turn", "end of road"}
_CONTINUE_LIKE = {"continue", "new name"}
# Merge priority when over the cap: lowest first (the least informative steps vanish first).
_LOW_VALUE = {"continue", "other", "straight"}
_MEDIUM_VALUE = {"slight_left", "slight_right", "merge", "merge_left", "merge_right"}


def clean_text(value, limit: int) -> str:
    """Printable text only: whitespace collapsed, control/format characters dropped, capped."""
    if not isinstance(value, str):
        return ""
    spaced = "".join(" " if char.isspace() else char for char in value[: limit * 4])
    printable = "".join(char for char in spaced if unicodedata.category(char)[0] != "C")
    return " ".join(printable.split())[:limit]


def _side(modifier: str | None) -> str | None:
    if modifier and modifier.endswith("left"):
        return "left"
    if modifier and modifier.endswith("right"):
        return "right"
    return None


def instruction_key(kind: str, modifier: str | None) -> str:
    if kind in _FIXED_KEYS:
        return _FIXED_KEYS[kind]
    if kind in _SIDED_KINDS:
        base, side = _SIDED_KINDS[kind], _side(modifier)
        return f"{base}_{side}" if side else base
    if kind in _TURN_LIKE:
        return _MODIFIER_KEYS.get(modifier or "", "other")
    if kind in _CONTINUE_LIKE:
        mapped = _CONTINUE_KEYS.get(modifier or "")
        return "continue" if mapped in (None, "straight") else mapped
    return "other"


def _roundabout_exit(value) -> int | None:
    ok = isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 50  # noqa: PLR2004
    return value if ok else None


def _simplify(step: dict) -> dict:
    maneuver = step["maneuver"]
    kind = clean_text(maneuver.get("type"), MAX_MANEUVER_LENGTH)
    modifier = clean_text(maneuver.get("modifier"), MAX_MANEUVER_LENGTH) or None
    location = step["location"]
    return {
        "instruction_key": instruction_key(kind, modifier),
        "name": clean_text(step.get("name"), MAX_NAME_LENGTH),
        "distance_m": round(step["distance"]),
        "duration_s": round(step["duration"]),
        "location": {"lat": location["lat"], "lng": location["lng"]},
        "maneuver": {
            "type": kind,
            "modifier": modifier,
            "exit": _roundabout_exit(maneuver.get("exit")),
        },
    }


def _priority(step: dict) -> int:
    key = step["instruction_key"]
    if key in _LOW_VALUE:
        return 0
    return 1 if key in _MEDIUM_VALUE else 2


def _merge_to_cap(steps: list[dict]) -> list[dict]:
    """Drop the least informative interior steps, adding their distance/duration to the step
    before them, so the step totals still equal the route totals. First and last are kept."""
    excess = len(steps) - MAX_STEPS
    interior = range(1, len(steps) - 1)
    victims = set(
        sorted(interior, key=lambda i: (_priority(steps[i]), steps[i]["distance_m"], i))[:excess]
    )
    merged: list[dict] = []
    for index, step in enumerate(steps):
        if index in victims:
            previous = merged[-1]
            merged[-1] = {
                **previous,
                "distance_m": previous["distance_m"] + step["distance_m"],
                "duration_s": previous["duration_s"] + step["duration_s"],
            }
        else:
            merged.append(step)
    return merged


def simplify_steps(steps: list[dict]) -> list[dict]:
    """Validated raw steps (see ``osrm_client.parse_route_response``) -> API steps. Pure.

    More than MAX_STEPS steps are merged down to MAX_STEPS (nothing is cut off at the end).
    """
    simplified = [_simplify(step) for step in steps]
    return _merge_to_cap(simplified) if len(simplified) > MAX_STEPS else simplified
