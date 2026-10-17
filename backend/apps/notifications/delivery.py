"""Delivering one ``NotificationLog`` (called by the Celery task ``notifications.send``).

Channel rule (ARCHITECTURE 12.1):

* CRITICAL events (overstay, refund needs a person): push AND Telegram, whichever are enabled.
* everything else: push first (every active device); Telegram only as the FALLBACK, i.e. when
  the user has no device, every device is dead, or push kept failing until the last attempt.

Safety properties:

* Idempotent: a row is claimed with a conditional UPDATE (status PENDING and no live lease), so
  two workers never send the same notification, and a SENT / SKIPPED / FAILED row is never
  touched again. A retry only goes to the channels that have not delivered yet.
* External calls happen outside any database transaction (this module opens none).
* ``last_error`` is a short code (``MessageRateExceeded``, ``telegram_429`` ...): never a token,
  a chat id, a URL or a response body.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from django.db.models import F, Q
from django.utils import timezone

from apps.accounts.models import Device, User

from . import links, messages, receipts
from .channels import expo_push, telegram
from .channels.expo_push import PushMessage, PushOutcome
from .channels.telegram import TelegramOutcome
from .events import CRITICAL_EVENTS
from .models import NotificationLog

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 30
BACKOFF_CAP_SECONDS = 1800
LEASE_SECONDS = 120
PUSH, TELEGRAM = "push", "telegram"
CHANNEL_ORDER = (PUSH, TELEGRAM)
Status = NotificationLog.Status


@dataclass(frozen=True)
class Delivery:
    """``retry_in``: seconds until the next attempt, or None when nothing more will happen."""

    retry_in: float | None = None


@dataclass
class _Round:
    """What one attempt achieved."""

    delivered: set[str] = field(default_factory=set)
    attempted: set[str] = field(default_factory=set)
    retry_in: float | None = None
    failed: str = ""  # permanent failure code
    blocked: bool = False
    skipped: str = ""  # reason nothing was tried (user_inactive)
    error: str = ""  # code of the failure behind ``retry_in``

    def need_retry(self, seconds: float, error: str) -> None:
        self.retry_in = seconds if self.retry_in is None else max(self.retry_in, seconds)
        self.error = error


def _backoff(attempts: int) -> float:
    return min(BACKOFF_BASE_SECONDS * 2 ** max(attempts - 1, 0), BACKOFF_CAP_SECONDS)


def _claim(log_id, now: datetime) -> NotificationLog | None:
    free = Q(lease_until__isnull=True) | Q(lease_until__lt=now)
    claimed = NotificationLog.objects.filter(free, pk=log_id, status=Status.PENDING).update(
        attempts=F("attempts") + 1,
        lease_until=now + timedelta(seconds=LEASE_SECONDS),
        updated_at=now,
    )
    if claimed != 1:
        return None
    return NotificationLog.objects.select_related("user").get(pk=log_id)


def deliver(log_id, *, now: datetime | None = None) -> Delivery:
    now = now or timezone.now()
    log = _claim(log_id, now)
    if log is None:
        return Delivery()
    try:
        outcome = _attempt(log)
    except Exception:  # noqa: BLE001 - never lose the row: treat it as a retryable failure
        logger.exception("notification %s: unexpected error", log.pk)
        outcome = _Round()
        outcome.need_retry(_backoff(log.attempts), "internal_error")
    return _finish(log, outcome, now)


# --- one attempt --------------------------------------------------------------------------------


def _attempt(log: NotificationLog) -> _Round:
    outcome = _Round()
    user = log.user
    if not user.is_active:
        outcome.skipped = "user_inactive"
        return outcome
    message = messages.render(log.event, user.language, log.context)
    already = {name for name in log.delivered.split("+") if name}
    final = log.attempts >= MAX_ATTEMPTS
    critical = log.event in CRITICAL_EVENTS
    tokens = list(Device.objects.filter(user=user).values_list("expo_push_token", flat=True))
    telegram_enabled = bool(user.tg_notifications and user.telegram_id)

    if tokens and PUSH not in already:
        _push(log, message, tokens, outcome, final=final)
    push_done = PUSH in already or PUSH in outcome.delivered
    push_waiting = outcome.retry_in is not None
    wants_telegram = telegram_enabled and TELEGRAM not in already
    if wants_telegram and (critical or not (push_done or push_waiting)):
        _telegram(log, user, message, outcome, final=final)
    return outcome


def _push(log, message, tokens, outcome: _Round, *, final: bool) -> None:
    outcome.attempted.add(PUSH)
    data = {"event": log.event}
    booking_id = log.context.get("booking_id")
    deep_link = _safe(links.booking_deep_link, booking_id)
    if deep_link:
        data.update(url=deep_link, booking_id=booking_id)
    batch = [PushMessage(t, message.title, message.body, data) for t in tokens]
    try:
        results = expo_push.send(batch)
    except Exception:  # noqa: BLE001 - the client must not take the row down with it
        logger.exception("notification %s: push client failed", log.pk)
        results = [expo_push.PushResult(PushOutcome.RETRY, "push_error")] * len(batch)
    for sent, result in zip(batch, results, strict=True):
        if result.outcome is PushOutcome.OK:
            receipts.remember(result.ticket_id, sent.token)
    dead = [
        sent.token
        for sent, result in zip(batch, results, strict=True)
        if result.outcome is PushOutcome.INVALID_TOKEN
    ]
    if dead:
        Device.objects.filter(user_id=log.user_id, expo_push_token__in=dead).delete()
    if any(r.outcome is PushOutcome.OK for r in results):
        outcome.delivered.add(PUSH)
        return
    retries = [r for r in results if r.outcome is PushOutcome.RETRY]
    failures = [r for r in results if r.outcome is PushOutcome.FAILED]
    if retries and not final:
        wait = max((r.retry_after or _backoff(log.attempts)) for r in retries)
        outcome.need_retry(wait, retries[0].error)
    elif retries or failures:
        outcome.failed = (retries or failures)[0].error


def _telegram(log, user: User, message, outcome: _Round, *, final: bool) -> None:
    outcome.attempted.add(TELEGRAM)
    booking_id = log.context.get("booking_id")
    url = _safe(links.booking_universal_link, booking_id)
    result = telegram.send(
        user.telegram_id,
        f"{message.title}\n{message.body}",
        button_label=messages.OPEN_BUTTON[messages.pick_language(user.language)] if url else None,
        button_url=url,
    )
    if result.outcome is TelegramOutcome.OK:
        outcome.delivered.add(TELEGRAM)
    elif result.outcome is TelegramOutcome.BLOCKED:
        User.objects.filter(pk=user.pk).update(tg_notifications=False)
        outcome.blocked = True
    elif result.outcome is TelegramOutcome.RETRY and not final:
        outcome.need_retry(result.retry_after or _backoff(log.attempts), result.error)
    else:
        outcome.failed = result.error or "telegram_error"


def _safe(builder, booking_id):
    if not booking_id:
        return None
    try:
        return builder(booking_id)
    except ValueError:
        return None


# --- recording the result ------------------------------------------------------------------------


def _join(channels) -> str:
    return "+".join(name for name in CHANNEL_ORDER if name in channels)


def _finish(log: NotificationLog, outcome: _Round, now: datetime) -> Delivery:
    already = {name for name in log.delivered.split("+") if name}
    delivered = already | outcome.delivered
    values: dict = {
        "channel": _join(outcome.attempted),
        "delivered": _join(delivered),
        "lease_until": None,
        "updated_at": now,
    }
    retry_in = outcome.retry_in
    if retry_in is not None:
        values.update(status=Status.PENDING, last_error=outcome.error[:120])
    elif delivered:
        values.update(status=Status.SENT, sent_at=now, last_error="")
    elif outcome.failed:
        values.update(status=Status.FAILED, last_error=outcome.failed[:120])
    else:
        reason = outcome.skipped or ("telegram_blocked" if outcome.blocked else "no_channel")
        values.update(status=Status.SKIPPED, last_error=reason)
    NotificationLog.objects.filter(pk=log.pk).update(**values)
    return Delivery(retry_in=retry_in)
