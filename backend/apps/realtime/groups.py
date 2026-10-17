"""Channel-layer group names. They are built ONLY from a parsed UUID or a validated geohash, so
no client-supplied text ever becomes part of a name (no injection into other groups)."""

import re
import uuid

from apps.core.geomath import geohash_encode

GEOHASH_LENGTH = 5
# geohash base32 alphabet: digits and lower-case letters except a, i, l, o
_GEOHASH_RE = re.compile(r"[0-9b-hjkmnp-z]{5}")

KIND_LOT = "lot"
KIND_GEO = "geo"
KIND_OPERATOR_LOT = "operator_lot"
CLIENT_KINDS = (KIND_LOT, KIND_GEO, KIND_OPERATOR_LOT)


class InvalidGroup(ValueError):  # noqa: N818 - reads better than InvalidGroupError at call sites
    """The id is not a canonical UUID / geohash5."""


def parse_uuid(value) -> uuid.UUID:
    """Strict UUID: exactly the 36-character textual form (no braces, urn:, spaces, ints)."""
    if not isinstance(value, str | uuid.UUID):
        raise InvalidGroup("not a uuid")
    text = str(value)
    if len(text) != 36:
        raise InvalidGroup("not a uuid")
    try:
        return uuid.UUID(text)
    except ValueError:
        raise InvalidGroup("not a uuid") from None


def parse_geohash(value) -> str:
    if not isinstance(value, str):
        raise InvalidGroup("not a geohash")
    text = value.lower()
    if not _GEOHASH_RE.fullmatch(text) or not value.isascii():
        raise InvalidGroup("not a geohash")
    return text


def lot_group(lot_id) -> str:
    return f"lot_{parse_uuid(lot_id)}"


def geo_group(geohash) -> str:
    return f"geo_{parse_geohash(geohash)}"


def user_group(user_id) -> str:
    return f"user_{parse_uuid(user_id)}"


def operator_group(lot_id) -> str:
    return f"operator_lot_{parse_uuid(lot_id)}"


def geohash5_of(lat: float, lng: float) -> str:
    return geohash_encode(lat, lng, GEOHASH_LENGTH)
