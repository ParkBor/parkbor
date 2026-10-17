"""Money at the provider boundary. Amounts are ``Decimal`` in soums everywhere inside the app;
only Payme speaks tiyin (1 soum = 100 tiyin) and only this module converts. No floats."""

import re
from decimal import Decimal

TIYIN_PER_SOUM = 100
CENT = Decimal("0.01")
# Booking.amount is DecimalField(12, 2): the largest value, in tiyin.
MAX_TIYIN = 10**12 - 1
MAX_DIGITS = 12  # Decimal.adjusted() of the largest accepted amount is 11
_SOUM_TEXT = re.compile(r"[0-9]{1,10}(\.[0-9]{1,2})?", re.ASCII)


class InvalidAmount(ValueError):
    """The value is not a positive whole amount in the expected unit."""


def to_tiyin(soum: Decimal) -> int:
    """Soums -> tiyin; refuses fractions of a tiyin and non-positive values."""
    tiyin = soum * TIYIN_PER_SOUM
    if tiyin != tiyin.to_integral_value() or tiyin <= 0:
        raise ValueError("amount must be a positive whole number of tiyin")
    return int(tiyin)


def from_tiyin(tiyin: int) -> Decimal:
    return (Decimal(tiyin) / TIYIN_PER_SOUM).quantize(CENT)


def parse_tiyin(value: object) -> int:
    """A JSON value from Payme -> whole positive tiyin. ``bool`` is an ``int`` in Python: refused
    explicitly. Floats and strings are refused; ``Decimal`` (the JSON parser is told to produce it
    for non-integers) is accepted only when it is a whole number."""
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise InvalidAmount("amount must be a number")
    if isinstance(value, Decimal):
        # Bound the exponent BEFORE any arithmetic: Decimal("1e999999999") must never be expanded.
        if not value.is_finite() or value.adjusted() > MAX_DIGITS:
            raise InvalidAmount("amount is out of range")
        if value != value.to_integral_value():
            raise InvalidAmount("amount must be a whole number of tiyin")
        value = int(value)
    if not 0 < value <= MAX_TIYIN:
        raise InvalidAmount("amount is out of range")
    return value


def parse_soum_text(text: str) -> Decimal:
    """Click sends the amount as text ("12000", "12000.0", "12000.00"). Plain decimal notation
    with at most two places only: no exponent, sign, spaces or NaN. Never goes through float."""
    if not isinstance(text, str) or not _SOUM_TEXT.fullmatch(text):
        raise InvalidAmount("amount is malformed")
    value = Decimal(text)  # the regex above guarantees a plain decimal
    if value <= 0:
        raise InvalidAmount("amount must be positive")
    return value


def format_soum(value: Decimal) -> str:
    """``N.NN`` plain text for payment URLs."""
    return format(value.quantize(CENT), "f")


def is_number(value: object) -> bool:
    """A JSON number (``bool`` excluded: it is an ``int`` in Python but never an amount)."""
    return not isinstance(value, bool) and isinstance(value, int | Decimal)
