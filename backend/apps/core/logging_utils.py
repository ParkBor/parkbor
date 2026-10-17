"""Helpers that keep personal data out of logs."""

import json
import logging

_STANDARD_ATTRS = frozenset(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


class ExtraFieldsFormatter(logging.Formatter):
    """Plain formatter that appends ``extra={...}`` fields as one JSON object.

    Used for the audit logger, whose payload (actor, before, after) lives entirely in `extra`
    and would otherwise be silently dropped by a plain "%(message)s" format.
    """

    def format(self, record: logging.LogRecord) -> str:
        line = super().format(record)
        extras = {k: v for k, v in record.__dict__.items() if k not in _STANDARD_ATTRS}
        if not extras:
            return line
        return f"{line} {json.dumps(extras, default=str, sort_keys=True)}"


_VISIBLE_HEAD = 4
_VISIBLE_TAIL = 2


def mask_phone(phone: str | None) -> str:
    """Mask a phone number for logging: keep the first 4 and last 2 characters."""
    if not phone:
        return ""
    if len(phone) <= _VISIBLE_HEAD + _VISIBLE_TAIL:
        return "*" * len(phone)
    hidden = len(phone) - _VISIBLE_HEAD - _VISIBLE_TAIL
    return phone[:_VISIBLE_HEAD] + "*" * hidden + phone[-_VISIBLE_TAIL:]
