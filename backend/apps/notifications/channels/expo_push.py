"""Expo Push API client (https://exp.host/--/api/v2/push/send).

Synchronous httpx, always called from a Celery task, never inside a database transaction. Results
come back aligned with the input. Tokens, the access token and response bodies are NEVER logged.
"""

import json
import logging
import re
from dataclasses import dataclass, field
from enum import StrEnum

import httpx
from django.conf import settings

logger = logging.getLogger(__name__)

RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
MAX_BATCH = 100
MAX_RECEIPT_IDS = 300
MAX_PAYLOAD_BYTES = 4096
TIMEOUT_SECONDS = 10.0
_TOKEN_RE = re.compile(r"(?:Expo|Exponent)PushToken\[[A-Za-z0-9_\-]+\]")
_PERMANENT_ERRORS = frozenset({"MessageTooBig", "InvalidCredentials", "MismatchSenderId"})

_client: httpx.Client | None = None


class PushOutcome(StrEnum):
    OK = "ok"
    INVALID_TOKEN = "invalid_token"  # noqa: S105 - an outcome name; DeviceNotRegistered / malformed
    RETRY = "retry"  # rate limit, 5xx, network: try again later
    FAILED = "failed"  # permanent for this message


@dataclass(frozen=True)
class PushMessage:
    token: str
    title: str
    body: str
    data: dict = field(default_factory=dict)


@dataclass(frozen=True)
class PushResult:
    outcome: PushOutcome
    error: str = ""
    ticket_id: str = ""
    retry_after: float | None = None


def valid_token(token) -> bool:
    return isinstance(token, str) and _TOKEN_RE.fullmatch(token) is not None


def set_http_client(client: httpx.Client | None) -> None:
    """Install a client (tests pass one with a mock transport; None resets the default)."""
    global _client  # noqa: PLW0603
    _client = client


def _http() -> httpx.Client:
    global _client  # noqa: PLW0603
    if _client is None:
        _client = httpx.Client(timeout=TIMEOUT_SECONDS)
    return _client


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if settings.EXPO_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {settings.EXPO_ACCESS_TOKEN}"
    return headers


def _payload(message: PushMessage) -> dict:
    return {
        "to": message.token,
        "title": message.title,
        "body": message.body,
        "data": message.data,
        "sound": "default",
        "priority": "high",
    }


def _precheck(message: PushMessage) -> PushResult | None:
    if not valid_token(message.token):
        return PushResult(PushOutcome.INVALID_TOKEN, "malformed_token")
    size = len(json.dumps(_payload(message), ensure_ascii=False).encode("utf-8"))
    if size > MAX_PAYLOAD_BYTES:
        return PushResult(PushOutcome.FAILED, "payload_too_large")
    return None


def send(messages: list[PushMessage]) -> list[PushResult]:
    """Send ``messages``; the result list has one entry per message, in the same order."""
    results: list[PushResult | None] = [_precheck(m) for m in messages]
    pending = [i for i, result in enumerate(results) if result is None]
    for start in range(0, len(pending), MAX_BATCH):
        indexes = pending[start : start + MAX_BATCH]
        batch = _send_batch([messages[i] for i in indexes])
        for index, result in zip(indexes, batch, strict=True):
            results[index] = result
    return [r for r in results if r is not None]


def _send_batch(batch: list[PushMessage]) -> list[PushResult]:
    body = [_payload(m) for m in batch]
    try:
        response = _http().post(
            settings.EXPO_PUSH_URL, content=json.dumps(body), headers=_headers()
        )
    except httpx.HTTPError:
        logger.warning("expo push: network error (batch of %d)", len(batch))
        return [PushResult(PushOutcome.RETRY, "network_error")] * len(batch)
    failure = _http_failure(response)
    if failure is not None:
        return [failure] * len(batch)
    items = _json(response, "data")
    if not isinstance(items, list) or len(items) != len(batch):
        logger.warning("expo push: unexpected response shape (HTTP %d)", response.status_code)
        return [PushResult(PushOutcome.RETRY, "bad_response")] * len(batch)
    return [_item_result(item) for item in items]


def _http_failure(response: httpx.Response) -> PushResult | None:
    code = response.status_code
    if code == 200:
        return None
    logger.warning("expo push: HTTP %d", code)
    if code == 429 or code >= 500:
        return PushResult(PushOutcome.RETRY, f"http_{code}", retry_after=_retry_after(response))
    return PushResult(PushOutcome.FAILED, f"http_{code}")


def _retry_after(response: httpx.Response) -> float | None:
    try:
        return float(response.headers["Retry-After"])
    except (KeyError, ValueError):
        return None


def _json(response: httpx.Response, key: str):
    try:
        return response.json().get(key)
    except (ValueError, AttributeError):
        return None


def _item_result(item) -> PushResult:
    if not isinstance(item, dict):
        return PushResult(PushOutcome.RETRY, "bad_response")
    if item.get("status") == "ok":
        return PushResult(PushOutcome.OK, ticket_id=str(item.get("id", "")))
    return _error_result(item)


def _error_result(item: dict) -> PushResult:
    details = item.get("details")
    name = str(details.get("error", "")) if isinstance(details, dict) else ""
    name = re.sub(r"[^A-Za-z0-9]", "", name)[:60] or "unknown_error"
    if name == "DeviceNotRegistered":
        return PushResult(PushOutcome.INVALID_TOKEN, name)
    if name in _PERMANENT_ERRORS:
        return PushResult(PushOutcome.FAILED, name)
    return PushResult(PushOutcome.RETRY, name)  # MessageRateExceeded and anything unknown


def get_receipts(ticket_ids: list[str]) -> dict[str, PushResult]:
    """Receipts for ``ticket_ids`` that are ready (missing ids are not ready yet). Any failure
    returns ``{}``: receipts are checked again on the next run."""
    try:
        response = _http().post(
            RECEIPTS_URL, content=json.dumps({"ids": ticket_ids}), headers=_headers()
        )
    except httpx.HTTPError:
        logger.warning("expo receipts: network error")
        return {}
    if response.status_code != 200:
        logger.warning("expo receipts: HTTP %d", response.status_code)
        return {}
    data = _json(response, "data")
    if not isinstance(data, dict):
        return {}
    return {str(key): _item_result(value) for key, value in data.items()}
