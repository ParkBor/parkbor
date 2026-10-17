"""Allowlist filter for audit data: the log must never become a second copy of personal data.

An ALLOWLIST, not a denylist: a key that is not listed here is dropped (its NAME, which is a
code identifier and not personal data, is kept under ``_dropped`` so a developer notices), so a
new field with an innocent-looking name cannot leak a phone number or a name into the audit
table or its log line. Adding a key is a deliberate act: list it here after checking its value
is never personal.

Values: numbers, booleans, None, short text (<= 200 characters) and lists / dicts of those.
Plates are never stored: ``plate*`` keys are replaced by a keyed hash hint (``#ab12cd34``) that
lets a person recognise the same plate in two lines without being able to read or look it up.
"""

import hashlib
import hmac
import re

from django.conf import settings

# Structure of one audit record.
STRUCTURE_KEYS = frozenset({"before", "after"})
# Identifiers, states, amounts, times and outcome codes. Free text ("note", "override_note",
# "error", "why") is listed because staff reasons / provider errors are needed in disputes; it is
# length-capped and must not be filled with personal data by the callers (payments and the gate
# already restrict it).
ALLOWED_KEYS = frozenset(
    {
        # ids
        "lot", "slot", "booking", "operator", "refund", "payment", "actor", "from", "to",
        # states and outcomes
        "status", "outcome", "provider", "orphan", "collected", "collect", "force", "override",
        "role_promoted", "role_demoted", "kind", "reason", "why", "attempts", "failures",
        "window_seconds", "affected_bookings", "overstay_status", "overstay_needs_review",
        # money and counts
        "amount", "paid_amount", "refund_amount", "refund_percent", "extra_amount",
        "policy_refund", "provider_refund", "difference", "minutes", "actual_minutes",
        "overstay_minutes", "overstay_amount",
        # times
        "expires_at", "ends_at", "until", "checked_in_at", "checked_out_at", "cancelled_at",
        "hold_expires_at",
        # free text (capped)
        "note", "override_note", "error",
    }
)  # fmt: skip
PLATE_KEYS = frozenset({"plate", "plate_number", "vehicle_plate"})
MAX_DEPTH = 4
MAX_TEXT = 200
_DROPPED = "_dropped"
_SAFE_NAME = re.compile(r"[^a-z0-9_]")
_REDACTED_DEEP = "<dropped>"


def plate_hint(value) -> str:
    """``#`` + 8 hex characters of an HMAC (secret key) of the plate: stable, not reversible."""
    key = settings.SECRET_KEY.encode()
    return "#" + hmac.new(key, str(value).strip().upper().encode(), hashlib.sha256).hexdigest()[:8]


def mask_plate(value) -> str:
    """Kept for callers that want a hint of a plate; same as ``plate_hint`` (never part of it)."""
    return plate_hint(value) if str(value) else ""


def _name(key) -> str:
    return _SAFE_NAME.sub("", str(key).lower())[:40]


def _clean_value(value, depth: int):
    if isinstance(value, dict):
        return _clean_dict(value, depth + 1, structural=False)
    if isinstance(value, list | tuple | set | frozenset):
        return [_clean_value(item, depth + 1) for item in value]
    if value is None or isinstance(value, bool | int | float):
        return value
    return re.sub(r"\s+", " ", str(value))[:MAX_TEXT]


def _clean_dict(data: dict, depth: int, *, structural: bool) -> dict:
    if depth > MAX_DEPTH:
        return {_DROPPED: [_REDACTED_DEEP]}
    cleaned, dropped = {}, []
    allowed = ALLOWED_KEYS | STRUCTURE_KEYS if structural else ALLOWED_KEYS | PLATE_KEYS
    for key, item in data.items():
        lowered = str(key).lower()
        if lowered in PLATE_KEYS:
            cleaned[lowered] = plate_hint(item) if item not in (None, "") else item
        elif lowered in allowed:
            cleaned[lowered] = _clean_value(item, depth)
        else:
            dropped.append(_name(key))
    if dropped:
        cleaned[_DROPPED] = sorted(set(dropped))
    return cleaned


def scrub(value, depth: int = 0):
    """A JSON-safe copy of an audit payload (``{"before": {...}, "after": {...}}`` or a plain
    dict of allowed keys) with everything that is not allowlisted removed."""
    if isinstance(value, dict):
        structural = bool(value) and set(map(str, value)) <= STRUCTURE_KEYS
        return _clean_dict(value, depth, structural=structural)
    return _clean_value(value, depth)
