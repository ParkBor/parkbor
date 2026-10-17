import re

_SEPARATORS = re.compile(r"[\s\-().]")
_DIGITS = re.compile(r"\d{7,15}")


def normalize_phone(raw: str | None) -> str | None:
    """Return the phone in E.164-like form ("+998901234567"), or None if it is not valid."""
    if not raw:
        return None
    digits = _SEPARATORS.sub("", raw).removeprefix("+")
    if not _DIGITS.fullmatch(digits):
        return None
    return f"+{digits}"
