"""Bot login sessions in Redis: `tglogin:<token>` -> hash.

Flow: start_login -> bot /start <token> (bind_chat) -> contact (confirm_contact, issues the
6-digit code) -> verify_code from the app. The code is only stored as an HMAC hash, every
session lives 5 minutes, allows 5 wrong codes and can be consumed once.
"""

import hashlib
import hmac
import logging
import re
import secrets
from dataclasses import dataclass

from django.conf import settings
from redis.exceptions import WatchError

from apps.core.exceptions import (
    InvalidCodeError,
    LoginExpiredError,
    LoginNotConfirmedError,
    ServiceUnavailableError,
)
from apps.core.logging_utils import mask_phone
from apps.core.redis_client import get_redis

logger = logging.getLogger(__name__)

LOGIN_TTL_SECONDS = 300
MAX_ATTEMPTS = 5
MAX_TXN_RETRIES = 5
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{16,64}", re.ASCII)

PENDING = "PENDING"
CONFIRMED = "CONFIRMED"
EXPIRED = "EXPIRED"

__all__ = [
    "CONFIRMED",
    "EXPIRED",
    "LOGIN_TTL_SECONDS",
    "MAX_ATTEMPTS",
    "PENDING",
    "InvalidCodeError",
    "LoginExpiredError",
    "LoginNotConfirmedError",
    "StartedLogin",
    "TelegramIdentity",
    "bind_chat",
    "cancel_login",
    "confirm_contact",
    "get_status",
    "is_valid_token",
    "start_login",
    "token_for_chat",
    "verify_code",
]


@dataclass(frozen=True)
class TelegramIdentity:
    telegram_id: int
    phone: str
    username: str
    first_name: str
    last_name: str


@dataclass(frozen=True)
class StartedLogin:
    token: str
    expires_in: int


def is_valid_token(token: str | None) -> bool:
    return isinstance(token, str) and TOKEN_PATTERN.fullmatch(token) is not None


def _key(token: str) -> str:
    return f"tglogin:{token}"


def _chat_key(telegram_id: int) -> str:
    return f"tgchat:{telegram_id}"


def _hash_code(token: str, code: str) -> str:
    message = f"{token}:{code}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), message, hashlib.sha256).hexdigest()


def start_login(device_id: str = "") -> StartedLogin:
    token = secrets.token_urlsafe(32)
    redis = get_redis()
    with redis.pipeline() as pipe:
        pipe.hset(_key(token), mapping={"status": PENDING, "attempts": 0, "device_id": device_id})
        pipe.expire(_key(token), LOGIN_TTL_SECONDS)
        pipe.execute()
    return StartedLogin(token=token, expires_in=LOGIN_TTL_SECONDS)


def get_status(token: str) -> str:
    if not is_valid_token(token):
        return EXPIRED
    return get_redis().hget(_key(token), "status") or EXPIRED


def _run_atomic(txn, key: str):
    """Run `txn(pipe)` under WATCH on `key`, retrying on conflicts a bounded number of times.

    Persistent contention fails closed (503) instead of looping forever.
    """
    redis = get_redis()
    for _ in range(MAX_TXN_RETRIES):
        with redis.pipeline() as pipe:
            try:
                pipe.watch(key)
                return txn(pipe)
            except WatchError:
                continue
    logger.error("login session contention, giving up")
    raise ServiceUnavailableError


def bind_chat(token: str, telegram_id: int) -> bool:
    """Remember which Telegram user opened the bot with this token (until the token expires)."""
    if not is_valid_token(token):
        return False
    key = _key(token)

    def txn(pipe) -> bool:
        ttl_ms = pipe.pttl(key)
        if ttl_ms <= 0 or pipe.hget(key, "status") != PENDING:
            return False
        pipe.multi()
        pipe.set(_chat_key(telegram_id), token, px=ttl_ms)
        pipe.execute()
        return True

    return _run_atomic(txn, key)


def token_for_chat(telegram_id: int) -> str | None:
    return get_redis().get(_chat_key(telegram_id))


def cancel_login(token: str) -> None:
    """Drop a session (e.g. when the code could not be delivered)."""
    if is_valid_token(token):
        get_redis().delete(_key(token))


def confirm_contact(token: str, identity: TelegramIdentity) -> str | None:
    """Attach the verified identity to the session and return the one-time 6-digit code.

    The check (alive, still PENDING) and all writes happen in one WATCH/MULTI/EXEC block, so
    concurrent confirmations yield a single code and an expired session is never revived.
    """
    if not is_valid_token(token):
        return None
    key = _key(token)
    code = f"{secrets.randbelow(10**6):06d}"

    def txn(pipe) -> bool:
        ttl_ms = pipe.pttl(key)
        if ttl_ms <= 0 or pipe.hget(key, "status") != PENDING:
            return False
        pipe.multi()
        pipe.hset(
            key,
            mapping={
                "status": CONFIRMED,
                "code_hash": _hash_code(token, code),
                "telegram_id": identity.telegram_id,
                "phone": identity.phone,
                "username": identity.username,
                "first_name": identity.first_name,
                "last_name": identity.last_name,
            },
        )
        pipe.pexpire(key, ttl_ms)  # never extend the original 5 minutes
        pipe.delete(_chat_key(identity.telegram_id))
        pipe.execute()
        return True

    if not _run_atomic(txn, key):
        return None
    logger.info(
        "login confirmed telegram_id=%s phone=%s", identity.telegram_id, mask_phone(identity.phone)
    )
    return code


def verify_code(token: str, code: str) -> TelegramIdentity:
    """Check the code; on success consume the session. 5 wrong codes cancel it.

    Read, attempt counting and deletion are one atomic block (WATCH/MULTI/EXEC), so parallel
    guesses cannot exceed the limit and a correct code is accepted exactly once.
    """
    if not is_valid_token(token):
        raise LoginExpiredError
    key = _key(token)

    def txn(pipe):
        data = pipe.hgetall(key)
        if not data or pipe.pttl(key) <= 0:
            return "expired", None
        if data.get("status") != CONFIRMED:
            return "not_confirmed", None
        attempts = int(data.get("attempts", 0)) + 1
        is_correct = hmac.compare_digest(_hash_code(token, code), data["code_hash"])
        pipe.multi()
        if is_correct or attempts >= MAX_ATTEMPTS:
            pipe.delete(key)
        else:
            pipe.hset(key, "attempts", attempts)
        pipe.execute()
        if not is_correct and attempts >= MAX_ATTEMPTS:
            logger.warning("login cancelled after %s wrong codes", attempts)
        return ("ok" if is_correct else "wrong"), data

    outcome, data = _run_atomic(txn, key)
    if outcome == "expired":
        raise LoginExpiredError
    if outcome == "not_confirmed":
        raise LoginNotConfirmedError
    if outcome == "wrong":
        raise InvalidCodeError
    return TelegramIdentity(
        telegram_id=int(data["telegram_id"]),
        phone=data["phone"],
        username=data["username"],
        first_name=data["first_name"],
        last_name=data["last_name"],
    )
