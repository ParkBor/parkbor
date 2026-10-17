"""Signed, one-time QR tokens (ARCHITECTURE 6.3 and 15).

The token is stateless: ``django.core.signing.dumps`` (HMAC, its own ``QR_SIGNING_KEY`` and salt,
rotatable through ``QR_SIGNING_KEY_FALLBACKS``) of ``{booking id, lot id, nonce, not-before,
expiry}`` and nothing personal. It is valid from ``start - BOOKING_QR_EARLY_MINUTES`` until
``end + BOOKING_QR_GRACE_MINUTES``.

One-time use: the DATABASE decides (``Booking.qr_nonce_used_at``, an atomic conditional UPDATE),
so losing Redis can never allow a replay; Redis only gives a fast "already used" answer and is
written after the transaction commits. ``services.rotate_qr_nonce`` replaces the nonce and
revokes every older token.

Two purposes (claim ``p``): an *entry* token (CONFIRMED booking; no ``p`` claim, so every token
issued before Step 9 stays valid) and an *exit* token (``p = "exit"``, asked for while the booking
is ACTIVE/OVERSTAY). The exit token lives from check-in until ``BOOKING_QR_EXIT_MINUTES`` after it
was issued (an overstaying driver is past the booking end). Check-in rotates the nonce, so the
exit token carries a fresh, unspent one; a token of the wrong purpose is refused (400
``qr_wrong_purpose``).

Check-in (Step 9) must run, inside ONE transaction holding the lot and booking locks:
``verify_token`` -> ``claims_match_booking`` -> status check (CONFIRMED) -> ``consume_nonce`` ->
the CONFIRMED -> ACTIVE transition. If anything after ``consume_nonce`` fails the transaction
rolls back and the nonce is unspent again.
"""

import hashlib
import logging
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from django.conf import settings
from django.core import signing
from django.db import transaction
from redis.exceptions import RedisError

from apps.core.exceptions import ApiError
from apps.core.redis_client import get_redis

from .conf import get_config
from .models import Booking

logger = logging.getLogger(__name__)

SALT = "habi.bookings.qr.v1"
PURPOSE_ENTRY = "entry"
PURPOSE_EXIT = "exit"
_PURPOSES = frozenset({PURPOSE_ENTRY, PURPOSE_EXIT})
MAX_TOKEN_LENGTH = 1024  # real tokens are ~200 characters; refuse anything bigger before parsing
_USED_KEY = "habi:qr:used:{booking_id}:{nonce}"


class QrError(ApiError):
    status_code = 400
    default_detail = "Invalid QR code."
    default_code = "qr_invalid"


class QrInvalid(QrError):
    pass


class QrForged(QrInvalid):
    """Shaped exactly like one of OUR tokens (payload:time:signature) but the signature is wrong:
    the only kind of "invalid" that suggests someone is forging codes. Same client answer
    (``qr_invalid``); the scan guard counts only this kind, so scanning some other QR code or a
    scrap of text never counts against an operator."""


class QrExpired(QrError):
    default_detail = "This QR code has expired."
    default_code = "qr_expired"


class QrNotYetValid(QrError):
    default_detail = "This QR code is not valid yet."
    default_code = "qr_not_yet_valid"


class QrWrongPurpose(QrError):
    default_detail = "This QR code cannot be used here (entry code at the exit, or vice versa)."
    default_code = "qr_wrong_purpose"


class QrWrongLot(QrError):
    default_detail = "This QR code belongs to another parking lot."
    default_code = "qr_wrong_lot"


@dataclass(frozen=True)
class QrClaims:
    booking_id: uuid.UUID
    lot_id: uuid.UUID
    nonce: str
    not_before: datetime
    expires_at: datetime
    purpose: str = PURPOSE_ENTRY


def new_nonce() -> str:
    """A fresh unguessable one-time value (22 URL-safe characters, 128 bits)."""
    return secrets.token_urlsafe(16)


def nonce_hash(nonce: str) -> str:
    """sha256 of a nonce: what is kept after the nonce itself is replaced (check-in)."""
    return hashlib.sha256(nonce.encode()).hexdigest()


def _key() -> str:
    return settings.QR_SIGNING_KEY or settings.SECRET_KEY


def _fallback_keys() -> list[str]:
    return list(settings.QR_SIGNING_KEY_FALLBACKS)


def _dump(booking, *, not_before: datetime, expires_at: datetime, purpose: str) -> str:
    payload = {
        "b": str(booking.pk),
        "l": str(booking.slot.zone.parking_lot_id),
        "n": booking.qr_nonce,
        "nb": int(not_before.timestamp()),
        "e": int(expires_at.timestamp()),
    }
    if purpose != PURPOSE_ENTRY:  # entry tokens keep the pre-Step-9 shape
        payload["p"] = purpose
    return signing.dumps(payload, key=_key(), salt=SALT, compress=True)


def issue_token(booking) -> tuple[str, datetime]:
    """Entry token (CONFIRMED booking): (token, expires_at)."""
    config = get_config()
    expires_at = booking.ends_at + config.qr_grace
    not_before = booking.starts_at - config.qr_early
    token = _dump(booking, not_before=not_before, expires_at=expires_at, purpose=PURPOSE_ENTRY)
    return token, expires_at


def issue_exit_token(booking, *, now: datetime | None = None) -> tuple[str, datetime]:
    """Exit token (ACTIVE/OVERSTAY booking): (token, expires_at). Does not change the nonce, so
    asking again (second device, app restart) gives a token that is valid until one is used."""
    now = now or datetime.now(UTC)
    expires_at = now + timedelta(minutes=get_config().qr_exit_minutes)
    not_before = (booking.checked_in_at or now) - timedelta(minutes=1)
    return _dump(
        booking, not_before=not_before, expires_at=expires_at, purpose=PURPOSE_EXIT
    ), expires_at


def _parse(raw) -> QrClaims:
    try:
        purpose = raw.get("p", PURPOSE_ENTRY)
        if purpose not in _PURPOSES:
            raise QrInvalid
        return QrClaims(
            booking_id=uuid.UUID(raw["b"]),
            lot_id=uuid.UUID(raw["l"]),
            nonce=str(raw["n"]),
            not_before=datetime.fromtimestamp(int(raw["nb"]), tz=UTC),
            expires_at=datetime.fromtimestamp(int(raw["e"]), tz=UTC),
            purpose=purpose,
        )
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError, OSError) as exc:
        raise QrInvalid from exc


_TOKEN_PART = re.compile(r"^[A-Za-z0-9_.\-]+$")


def looks_like_token(token: str) -> bool:
    """Shaped like ``django.core.signing`` output: three ``:``-separated URL-safe parts."""
    parts = token.split(":")
    return len(parts) == 3 and all(_TOKEN_PART.fullmatch(part) for part in parts)


def verify_token(
    token,
    *,
    expected_lot_id: uuid.UUID | None = None,
    expected_purpose: str | None = None,
    now: datetime | None = None,
) -> QrClaims:
    """Signature, validity window and (optionally) lot and purpose. Nothing is trusted before the
    signature. A forged or damaged token is always ``QrInvalid``, whatever else is wrong."""
    if not isinstance(token, str) or not token or len(token) > MAX_TOKEN_LENGTH:
        raise QrInvalid
    try:
        raw = signing.loads(token, key=_key(), salt=SALT, fallback_keys=_fallback_keys())
    except signing.BadSignature as exc:  # includes malformed/garbage input
        raise (QrForged if looks_like_token(token) else QrInvalid) from exc
    claims = _parse(raw)
    now = now or datetime.now(UTC)
    if now > claims.expires_at:
        raise QrExpired
    if now < claims.not_before:
        raise QrNotYetValid
    if expected_lot_id is not None and claims.lot_id != expected_lot_id:
        raise QrWrongLot
    if expected_purpose is not None and claims.purpose != expected_purpose:
        raise QrWrongPurpose
    return claims


def claims_match_booking(claims: QrClaims, booking) -> bool:
    """The token was issued for THIS booking, in this lot, with its current nonce."""
    return (
        claims.booking_id == booking.pk
        and claims.lot_id == booking.slot.zone.parking_lot_id
        and bool(booking.qr_nonce)
        and claims.nonce == booking.qr_nonce
    )


def _redis_key(claims: QrClaims) -> str:
    return _USED_KEY.format(booking_id=claims.booking_id, nonce=claims.nonce)


def _remember_in_redis(claims: QrClaims, ttl: int) -> None:
    try:
        get_redis().set(_redis_key(claims), "1", ex=ttl)
    except RedisError:
        logger.warning("could not cache a spent QR nonce (the database still holds it)")


def consume_nonce(claims: QrClaims, *, now: datetime | None = None) -> bool:
    """Spend the one-time nonce. True exactly once per nonce, even if Redis is empty or down."""
    now = now or datetime.now(UTC)
    try:
        if get_redis().exists(_redis_key(claims)):
            return False  # fast path: already spent
    except RedisError:
        logger.warning("QR fast-path check skipped: Redis unavailable")
    spent = Booking.objects.filter(
        pk=claims.booking_id, qr_nonce=claims.nonce, qr_nonce_used_at__isnull=True
    ).update(qr_nonce_used_at=now)
    if not spent:
        return False
    ttl = max(int((claims.expires_at - now).total_seconds()) + 1, 1)
    transaction.on_commit(lambda: _remember_in_redis(claims, ttl))
    return True
