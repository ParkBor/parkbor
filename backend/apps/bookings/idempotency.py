"""Idempotency-Key store for POST /bookings (ARCHITECTURE 10.3, layer 3).

Redis key ``habi:idem:booking:<user id>:<key>`` holds a JSON record:

* ``in_progress``: written with ``SET NX`` by the one request that runs. Its TTL
  (``BOOKING_IDEMPOTENCY_LOCK_SECONDS``, 120 s) is far above the longest possible request
  (DB ``lock_timeout`` + ``statement_timeout``) and is refreshed just before the work starts, so
  it only expires if the process died. Parallel duplicates wait for it (until a deadline of
  ``BOOKING_IDEMPOTENCY_WAIT_SECONDS``) and then get 409 ``idempotency_in_progress``;
* ``done`` (24 h): carries the booking id; a repeat with the same payload gets that booking back
  (whatever status it has reached since: the client sees the current truth).

A repeat with a different payload gets 422 ``idempotency_conflict`` in both states. Failed
requests release the key so the client can retry; only successes are remembered. A corrupted
record is discarded and the request starts afresh.
"""

import hashlib
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from datetime import UTC

from apps.core.redis_client import get_redis
from apps.payments import conf as payments_conf

from .conf import get_config
from .errors import IdempotencyConflict, IdempotencyInProgress, IdempotencyKeyError

logger = logging.getLogger(__name__)

KEY_PATTERN = re.compile(r"^[A-Za-z0-9_.:\-]{8,128}$")
_REDIS_KEY = "habi:idem:booking:{user_id}:{key}"
_POLL_SECONDS = 0.05
IN_PROGRESS, DONE = "in_progress", "done"


@dataclass(frozen=True)
class Begin:
    """Outcome of ``begin``: run the request (``token`` set) or replay a finished one."""

    token: str | None = None
    replay_booking_id: uuid.UUID | None = None


def validate_key(raw: str | None) -> str:
    key = (raw or "").strip()
    if not key:
        raise IdempotencyKeyError(
            "The Idempotency-Key header is required.", "idempotency_key_required"
        )
    if not KEY_PATTERN.fullmatch(key):
        raise IdempotencyKeyError(
            "Idempotency-Key must be 8-128 characters: letters, digits, '-', '_', '.', ':'.",
            "idempotency_key_invalid",
        )
    return key


def fingerprint(params: dict) -> str:
    """Hash of what the request MEANS (not how it was spelled): time zones are normalised."""

    def utc(value):
        return value.astimezone(UTC).replace(second=0, microsecond=0).isoformat()

    preferred = params.get("preferred_slot_id")
    canonical = {
        "lot": str(params["lot_id"]),
        "slot_type": params["slot_type"],
        "vehicle": str(getattr(params["vehicle"], "pk", params["vehicle"])),
        "start": utc(params["start"]),
        "end": utc(params["end"]),
        "preferred": None if preferred is None else str(preferred),
        "provider": params.get("payment_provider") or payments_conf.get_config().default_provider,
    }
    blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def _key(user_id, key: str) -> str:
    return _REDIS_KEY.format(user_id=user_id, key=key)


def _load(redis, redis_key: str, raw: str) -> dict | None:
    """Parse a stored record; a corrupt one is deleted (None) so the key is usable again."""
    try:
        record = json.loads(raw)
        if not isinstance(record, dict) or record["state"] not in (IN_PROGRESS, DONE):
            raise ValueError("unexpected record")
        record["fp"]  # noqa: B018 - presence check
        if record["state"] == DONE:
            uuid.UUID(record["booking_id"])
        return record
    except (ValueError, KeyError, TypeError):
        logger.warning("discarding a corrupt idempotency record")
        redis.delete(redis_key)
        return None


def begin(user_id, key: str, fp: str) -> Begin:
    config = get_config()
    redis = get_redis()
    redis_key = _key(user_id, key)
    token = uuid.uuid4().hex
    started = json.dumps({"fp": fp, "state": IN_PROGRESS, "token": token})
    deadline = time.monotonic() + config.idempotency_wait
    while True:
        if redis.set(redis_key, started, nx=True, ex=config.idempotency_lock):
            return Begin(token=token)
        raw = redis.get(redis_key)
        record = None if raw is None else _load(redis, redis_key, raw)
        if record is None:  # gone, expired or corrupt: try to take it again
            continue
        if record["fp"] != fp:
            raise IdempotencyConflict
        if record["state"] == DONE:
            return Begin(replay_booking_id=uuid.UUID(record["booking_id"]))
        if time.monotonic() >= deadline:
            raise IdempotencyInProgress
        time.sleep(_POLL_SECONDS)


def refresh(user_id, key: str, token: str) -> None:
    """Push the in-progress expiry out again (call right before the long part of the request)."""
    redis = get_redis()
    redis_key = _key(user_id, key)
    raw = redis.get(redis_key)
    record = None if raw is None else _load(redis, redis_key, raw)
    if record and record["state"] == IN_PROGRESS and record["token"] == token:
        redis.expire(redis_key, get_config().idempotency_lock)


def complete(user_id, key: str, token: str, booking_id, fp: str | None = None) -> None:
    """Remember the result for 24 h. Only the request that owns the marker may write it: if
    the marker now belongs to someone else (it expired and was retaken) nothing is written.
    `fp` lets us record the result when the marker has vanished entirely."""
    redis = get_redis()
    redis_key = _key(user_id, key)
    raw = redis.get(redis_key)
    record = None if raw is None else _load(redis, redis_key, raw)
    if record is not None and record.get("token") != token:
        logger.warning("idempotency marker belongs to another request; result not recorded")
        return
    fp = record["fp"] if record else fp
    if fp is None:
        logger.warning("idempotency record vanished before completion")
        return
    done = {"fp": fp, "state": DONE, "token": token, "booking_id": str(booking_id)}
    redis.set(redis_key, json.dumps(done), ex=get_config().idempotency_ttl)


def release(user_id, key: str, token: str) -> None:
    """Drop OUR in-progress marker (never someone else's, never a finished record)."""
    redis = get_redis()
    redis_key = _key(user_id, key)
    raw = redis.get(redis_key)
    record = None if raw is None else _load(redis, redis_key, raw)
    if record and record["state"] == IN_PROGRESS and record["token"] == token:
        redis.delete(redis_key)
