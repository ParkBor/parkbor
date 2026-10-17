"""Brute-force guard for CHECK-IN (ARCHITECTURE 15, Step 9).

A QR token cannot be guessed (HMAC), but a stolen phone or a rogue operator can still hammer the
scanner with forged codes or guessed booking ids. Only evidence of FORGING counts:

* a token shaped like ours whose signature is wrong (``QrForged``), and
* a booking id that does not exist (``booking_not_found``, from check-out).

Everything else never counts: a scrap of text or somebody else's QR code (bystanders and curious
drivers), and every honest refusal (outdated or spent code, other lot, wrong plate, expired, not
paid, ...), so a confused queue at the gate cannot lock the operator.

The counter is per OPERATOR (not per lot: a lot id comes from the client, so a per-lot key could be
dodged with a fresh UUID on every try). After ``OPERATOR_SCAN_FAIL_LIMIT`` such failures within
``OPERATOR_SCAN_FAIL_WINDOW_SECONDS`` (defaults 10 / 300 s) that operator's CHECK-IN answers 429
``scan_locked`` (with ``Retry-After``) until the window ends. CHECK-OUT is never locked: cars must
always be able to leave. Its failures are counted in a separate counter (so a guessing campaign at
the exit is audited as ``operator.scan_suspicious``) but that counter never blocks anything.
"""

import logging

from django.conf import settings

from apps.bookings.gate_errors import BookingNotFound, ScanLocked
from apps.bookings.qr import QrForged
from apps.core.attempts import FailureCounter
from apps.parking.services import audit

logger = logging.getLogger(__name__)

CHECK_IN = "in"
CHECK_OUT = "out"
_AUDIT_ACTION = {CHECK_IN: "operator.scan_locked", CHECK_OUT: "operator.scan_suspicious"}


def _counter(kind: str) -> FailureCounter:
    return FailureCounter(
        f"scanfail{kind}",
        settings.OPERATOR_SCAN_FAIL_LIMIT,
        settings.OPERATOR_SCAN_FAIL_WINDOW_SECONDS,
    )


def is_forging(exc: Exception) -> bool:
    """Does this refusal look like guessing / forging (and so count)?"""
    return isinstance(exc, QrForged | BookingNotFound)


def assert_open(user) -> None:
    """Raise 429 ``scan_locked`` if this operator is locked out of check-in."""
    remaining = _counter(CHECK_IN).seconds_locked(str(user.pk))
    if remaining:
        error = ScanLocked()
        error.wait = remaining  # becomes the Retry-After header
        raise error


def record_failure(user, exc: Exception, kind: str = CHECK_IN) -> None:
    """Count a failed scan if it looks like forging; audit the moment the limit is reached (once).
    `kind` is where it happened; only ``CHECK_IN`` ever blocks."""
    if not is_forging(exc):
        return
    counter, key = _counter(kind), str(user.pk)
    count = counter.record(key)
    if count >= settings.OPERATOR_SCAN_FAIL_LIMIT and counter.first_time_locked(key):
        try:
            audit(
                actor=user,
                action=_AUDIT_ACTION[kind],
                obj_id=user.pk,
                before={},
                after={
                    "failures": count,
                    "window_seconds": settings.OPERATOR_SCAN_FAIL_WINDOW_SECONDS,
                },
            )
        except Exception:  # noqa: BLE001 - an audit hiccup must not replace the API answer
            logger.exception("could not audit the scan guard")
