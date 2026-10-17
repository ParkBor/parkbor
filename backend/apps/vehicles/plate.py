"""Licence plate normalisation (Uzbekistan) with a soft format check. Pure, no DB."""

import re

MIN_LENGTH, MAX_LENGTH = 5, 12
_SEPARATORS = re.compile(r"[\s\-]+")
_ALNUM = re.compile(r"^[A-Z0-9]+$")

# Region codes of Uzbekistan plates (Tashkent city/region, Syrdarya, Jizzakh, Samarkand, Fergana,
# Namangan, Andijan, Kashkadarya, Surkhandarya, Bukhara, Navoi, Khorezm, Karakalpakstan).
REGIONS = ("01", "10", "20", "25", "30", "40", "50", "60", "70", "75", "80", "85", "90", "95")
_REGION = "(?:" + "|".join(REGIONS) + ")"
_STANDARD = re.compile(rf"^{_REGION}(?:[A-Z]\d{{3}}[A-Z]{{2}}|\d{{3}}[A-Z]{{3}}|[A-Z]\d{{4}})$")


class InvalidPlate(ValueError):
    pass


def normalize_plate(raw: str) -> str:
    """Upper-case, no spaces/dashes. Rejects non-ASCII (Cyrillic look-alikes would otherwise
    create "different" plates), wrong length, and plates without both a digit and a letter-or-
    digit mix of at least MIN_LENGTH characters."""
    if not isinstance(raw, str):
        raise InvalidPlate("Plate number must be a string.")
    compact = _SEPARATORS.sub("", raw)
    if not compact.isascii():
        raise InvalidPlate("Plate number may contain only Latin letters and digits.")
    plate = compact.upper()
    if not MIN_LENGTH <= len(plate) <= MAX_LENGTH:
        raise InvalidPlate(f"Plate number must be {MIN_LENGTH}-{MAX_LENGTH} characters.")
    if not _ALNUM.match(plate):
        raise InvalidPlate("Plate number may contain only Latin letters and digits.")
    if not any(ch.isdigit() for ch in plate) or not any(ch.isalpha() for ch in plate):
        raise InvalidPlate("Plate number must contain both letters and digits.")
    return plate


def is_standard_uz_plate(plate: str) -> bool:
    """Known Uzbekistan layouts: 01A123BC, 01123ABC, 01A1234. Informational only: foreign,
    diplomatic and temporary plates are legitimate and must not be rejected."""
    return bool(_STANDARD.match(plate))
