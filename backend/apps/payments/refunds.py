"""Refunds: creating them (inside the transaction that decided them) and delivering them.

A refund is created in the SAME transaction as the decision (cancelled booking, payment that
arrived too late), so either both exist or neither does; the provider call happens later, from
Celery, outside any database lock:

    create_*_refund()   -> Refund(PENDING) + on_commit enqueue ``payments.send_refund``
    process_refund()    -> claim  (atomic conditional UPDATE PENDING|SENT -> SENT, attempts + 1)
                        -> provider call (no lock held)
                        -> record (fenced UPDATE: only while still SENT by THIS attempt)
                        -> finalise (lot + booking lock; best effort: payment REFUNDED, history)

DELIVERY IS AT-LEAST-ONCE, not exactly-once. A worker that dies (or whose answer is lost) after
the provider acted leaves the refund SENT; once its 2-minute lease runs out the refund is
claimed again and the provider is called again. That is safe for Click (a second reversal is
refused by Click; with ``CLICK_REVERSAL_DONE_CODES`` configured that answer counts as DONE, and
``CLICK_STATUS_CHECK`` can ask first) and never double-pays, because the provider holds the
money, not us. What IS exactly-once: creating the refund (unique ``idempotency_key``), claiming
it (database-atomic), and applying a result (fenced by status and attempt number: a late result
of an abandoned attempt is discarded and can neither overwrite a newer attempt nor a refund the
provider already settled).

``Payment.refunded_amount`` is reserved at creation, so the sum of refunds can never exceed the
payment (DB CHECK) and a booking's ``refund_amount`` never exceeds ``paid_amount``.
"""

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from enum import StrEnum

from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone

from apps.bookings import services as booking_services
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus
from apps.core import events
from apps.core.exceptions import Conflict, InvalidTransition, NotFoundError
from apps.parking.services import audit

from . import conf, lifecycle, selectors
from .models import Payment, PaymentStatus, Refund, RefundReason, RefundStatus
from .providers.base import RefundResult, ResultKind
from .providers.registry import get_provider

__all__ = [
    "RefundOutcome",
    "RefundResult",
    "ResultKind",
    "create_auto_refund",
    "create_booking_refund",
    "enqueue_refund",
    "process_refund",
    "refund_ids_to_requeue",
    "resolve_manual_refund",
    "settle_by_provider",
]

logger = logging.getLogger(__name__)

# While a refund is SENT its worker owns it; after this lease a crashed worker's claim is stale.
CLAIM_LEASE = timedelta(minutes=2)
# Below Celery's Redis visibility timeout (config sets it to 2 h) with a wide margin.
MAX_BACKOFF_SECONDS = 1800
OPERATOR_FAILED = "operator_failed"


def _holding_filter() -> Q:
    """Refunds that hold money back from the payment: everything except a refund an OPERATOR gave
    up on (its reservation was returned). An automatic FAILED keeps its reservation: it may be
    retried or settled."""
    return ~Q(status=RefundStatus.FAILED, last_error=OPERATOR_FAILED)


def reserved_total(payment: Payment) -> Decimal:
    """What the payment's refunds hold back. The invariant, always:
    ``reserved_total(payment) == payment.refunded_amount``."""
    total = Refund.objects.filter(_holding_filter(), payment=payment).aggregate(
        total=Sum("amount")
    )["total"]
    return total or Decimal(0)


@dataclass(frozen=True)
class RefundOutcome:
    refund: Refund | None
    retry_in: int | None = None  # seconds until the next attempt; None = nothing more to do


# --- creation (callers hold the lot + booking locks) -------------------------------------------


def enqueue_refund(refund_id) -> None:
    """Queue delivery. Never raises: the refund row is committed, and ``retry_failed_webhooks``
    enqueues it again if the broker was down."""
    from . import tasks

    try:
        tasks.send_refund.apply_async((str(refund_id),))
    except Exception:  # noqa: BLE001
        logger.exception("could not enqueue refund %s", refund_id)


def _record_pending(refund: Refund, booking: Booking) -> None:
    booking_services.log_booking_event(
        booking,
        reason="refund_pending",
        meta={"refund": str(refund.pk), "amount": str(refund.amount), "why": refund.reason},
    )
    transaction.on_commit(lambda: enqueue_refund(refund.pk))


def create_booking_refund(booking: Booking, amount: Decimal) -> Refund:
    """The driver cancelled a paid booking: refund ``amount`` (the policy share of what was paid).
    Idempotent per booking. NEVER returns nothing: the promise of ``amount`` is always on the
    books. It is taken from the booking's PAID payments in order (earliest first; each capped by
    what it still holds, so a refund never exceeds its payment); whatever no payment can cover
    (no paid payment at all, or a shortfall) becomes a MANUAL record that a person settles.
    A cancel that silently dropped the refund would lose the customer's money. The first refund
    is returned (key ``cancel:<id>``; further ones ``:2``, ``:3``, ``:shortfall``)."""
    key = f"cancel:{booking.pk}"
    existing = Refund.objects.filter(idempotency_key=key).first()
    if existing is not None:
        return existing
    remaining = amount
    created: list[Refund] = []
    for candidate in selectors.paid_payments_for_refund(booking):
        if remaining <= 0:
            break
        payment = _lock_first([candidate])
        if payment is None:
            continue
        part = min(remaining, payment.amount - payment.refunded_amount)
        suffix = "" if not created else f":{len(created) + 1}"
        refund = lifecycle.create_refund(
            payment=payment,
            booking=booking,
            amount=part,
            reason=RefundReason.BOOKING_CANCELLED,
            idempotency_key=f"{key}{suffix}",
        )
        _reserve(payment, part)
        _record_pending(refund, booking)
        created.append(refund)
        remaining -= part
    if not created:
        logger.error("booking %s: no paid payment to refund from: manual refund", booking.pk)
        return _manual_refund(booking, amount, key, "no_paid_payment")
    if remaining > 0:
        logger.error("booking %s: payments hold less than the refund: manual rest", booking.pk)
        _manual_refund(booking, remaining, f"{key}:shortfall", "shortfall")
    return created[0]


def _manual_refund(booking: Booking, amount: Decimal, key: str, code: str) -> Refund:
    refund = lifecycle.create_refund(
        status=RefundStatus.MANUAL,
        payment=None,
        booking=booking,
        amount=amount,
        reason=RefundReason.BOOKING_CANCELLED,
        idempotency_key=key,
        last_error=code,
    )
    _record_status(refund, booking)
    return refund


def create_auto_refund(payment: Payment, reason: str, *, now: datetime) -> Refund | None:
    """Money arrived that the booking cannot keep: give back all of it. The caller holds the
    lot, booking and payment locks. Idempotent per payment."""
    key = f"auto:{payment.pk}"
    existing = Refund.objects.filter(idempotency_key=key).first()
    if existing is not None:
        return existing
    amount = payment.amount - payment.refunded_amount
    if amount <= 0:
        return None
    refund = lifecycle.create_refund(
        payment=payment, booking=payment.booking, amount=amount, reason=reason, idempotency_key=key
    )
    _reserve(payment, amount)
    _record_pending(refund, payment.booking)
    return refund


def _lock_first(candidates: list[Payment]) -> Payment | None:
    """Re-read the first candidate under a row lock (the list was selected without one)."""
    for candidate in candidates:
        locked = Payment.objects.select_for_update(of=("self",)).get(pk=candidate.pk)
        if locked.status == PaymentStatus.PAID and locked.amount > locked.refunded_amount:
            return locked
    return None


def _reserve(payment: Payment, amount: Decimal) -> None:
    payment.refunded_amount = payment.refunded_amount + amount
    payment.save(update_fields=["refunded_amount", "updated_at"])


def settle_by_provider(payment: Payment, booking: Booking, *, now: datetime) -> None:
    """The provider returned the payment on its own side (Payme CancelTransaction after Perform):
    refunds we were waiting for are DONE; if they do not cover the payment, one DONE record is
    added for the rest so the books show where the money went. Caller holds the locks.

    A provider cancels the WHOLE transaction. If the booking's policy refund was smaller (a late
    cancel refunds 50%), the difference is money the policy meant to keep: it is logged and put
    in the booking history for a person to settle with the customer, never silently absorbed."""
    holding = _holding_filter()
    open_refunds = list(
        Refund.objects.select_for_update(of=("self",))
        .filter(holding, payment=payment)
        .exclude(status=RefundStatus.DONE)
    )
    for refund in open_refunds:
        lifecycle.set_refund_status(
            refund, RefundStatus.DONE, done_at=now, last_error="", next_attempt_at=None
        )
        _record_status(refund, booking)
    covered = Refund.objects.filter(holding, payment=payment).aggregate(total=Sum("amount"))[
        "total"
    ] or Decimal(0)
    rest = payment.amount - covered
    if rest > 0:
        refund = lifecycle.create_refund(
            payment=payment,
            booking=booking,
            amount=rest,
            status=RefundStatus.DONE,
            reason=RefundReason.PROVIDER,
            idempotency_key=f"provider:{payment.pk}",
            done_at=now,
        )
        _record_status(refund, booking)
    _flag_policy_difference(payment, booking)


def _flag_policy_difference(payment: Payment, booking: Booking) -> None:
    if booking.status != BookingStatus.CANCELLED or booking.refund_amount >= payment.amount:
        return
    difference = payment.amount - booking.refund_amount
    logger.warning(
        "booking %s: provider returned the whole payment, policy refund was smaller", booking.pk
    )
    booking_services.log_booking_event(
        booking,
        reason="provider_refund_exceeds_policy",
        meta={
            "payment": str(payment.pk),
            "policy_refund": str(booking.refund_amount),
            "provider_refund": str(payment.amount),
            "difference": str(difference),
        },
    )


FINAL_NOTIFIED = (RefundStatus.DONE, RefundStatus.MANUAL, RefundStatus.FAILED)


def _announce_final(refund: Refund, booking: Booking) -> None:
    """Tell the driver (notifications app, after commit) how the refund ended. Deduplicated per
    refund there, so a repeated finalisation (sweep repair) never sends a second message."""
    if refund.status not in FINAL_NOTIFIED or booking.user_id is None:
        return
    refund_id, booking_id, user_id = refund.pk, booking.pk, booking.user_id
    status, amount = refund.status, refund.amount
    transaction.on_commit(
        lambda: events.emit(
            "refund_final",
            refund_id=refund_id,
            booking_id=booking_id,
            user_id=user_id,
            status=status,
            amount=amount,
        )
    )


def _record_status(refund: Refund, booking: Booking) -> None:
    _announce_final(refund, booking)
    booking_services.log_booking_event(
        booking,
        reason=f"refund_{refund.status.lower()}",
        meta={
            "refund": str(refund.pk),
            "amount": str(refund.amount),
            "attempts": refund.attempts,
            "error": refund.last_error,
        },
    )


# --- delivery (Celery) ----------------------------------------------------------------------


def process_refund(refund_id, *, now: datetime | None = None) -> RefundOutcome:
    """Send one refund to its provider. Safe to call any number of times, concurrently or after a
    crash (see the module docstring for the exact guarantees)."""
    now = now or timezone.now()
    if not Refund.objects.filter(pk=refund_id).exists():
        return RefundOutcome(None)
    attempts = lifecycle.claim_refund(refund_id, now=now, lease=CLAIM_LEASE)
    if attempts is None:
        return RefundOutcome(Refund.objects.filter(pk=refund_id).first())
    refund = Refund.objects.select_related("payment").get(pk=refund_id)
    result = _call_provider(refund, refund.payment, attempts)
    return _record(refund, attempts, result, now)


def _call_provider(refund: Refund, payment: Payment, attempt: int) -> RefundResult:
    try:
        return get_provider(payment.provider).refund(payment, refund.amount, attempt=attempt)
    except Exception as exc:  # noqa: BLE001 - a provider bug must not lose the refund
        # Only the exception TYPE: its message may contain a URL or a header value.
        logger.error("refund %s: provider raised %s", refund.pk, type(exc).__name__)
        return RefundResult(ResultKind.RETRY, error="unexpected_error")


def _backoff_seconds(attempts: int) -> int:
    base = conf.get_config().refund_backoff_seconds
    return min(base * 2 ** max(attempts - 1, 0), MAX_BACKOFF_SECONDS)


def _record(refund: Refund, attempts: int, result: RefundResult, now: datetime) -> RefundOutcome:
    """Write the result with ONE fenced UPDATE (no booking / lot lock: it cannot fail on a busy
    lot and lose a result the provider already acted on), then do the side effects best effort."""
    retry_in = None
    next_at = None
    if result.kind == ResultKind.DONE:
        to, error = RefundStatus.DONE, ""
    elif result.kind == ResultKind.MANUAL:
        to, error = RefundStatus.MANUAL, result.error
    elif result.kind == ResultKind.FAILED:
        to, error = RefundStatus.FAILED, result.error
    elif attempts >= conf.get_config().refund_max_attempts:
        to, error = RefundStatus.FAILED, "retries_exhausted"
    else:
        retry_in = _backoff_seconds(attempts)
        to, error, next_at = RefundStatus.PENDING, result.error, now + timedelta(seconds=retry_in)
    applied = lifecycle.finish_refund_attempt(
        refund.pk,
        attempts,
        to=to,
        now=now,
        provider_ref=result.provider_ref,
        last_error=error,
        next_attempt_at=next_at,
    )
    fresh = Refund.objects.get(pk=refund.pk)
    if not applied:
        logger.warning(
            "refund %s: result of attempt %d discarded (superseded): %s%s%s",
            refund.pk,
            attempts,
            result.kind,
            f" ref={result.provider_ref}" if result.provider_ref else "",
            f" error={error}" if error else "",
        )
        return RefundOutcome(fresh, None)
    if retry_in is None:
        _finalise_quietly(fresh)
    return RefundOutcome(fresh, retry_in)


def _finalise_quietly(refund: Refund) -> None:
    try:
        _finalise(refund.pk)
    except Exception as exc:  # noqa: BLE001 - the refund row is already final; sweep repairs
        logger.error("refund %s: could not finalise (%s)", refund.pk, type(exc).__name__)
    if refund.status in (RefundStatus.FAILED, RefundStatus.MANUAL):
        logger.error(
            "refund %s is %s (%s): needs a person", refund.pk, refund.status, refund.last_error
        )


@booking_services.retrying
@transaction.atomic
def _finalise(refund_id) -> None:
    """Side effects of a final result, under the shared lock order: payment REFUNDED once its
    refunds are all DONE, and a line in the booking history."""
    refund = Refund.objects.get(pk=refund_id)
    booking_services.set_local_timeouts(conf.get_config().lock_timeout_seconds)
    try:
        _lot, booking = booking_services.lock_lot_and_booking(refund.booking_id)
    except NotFoundError:
        return
    refund = Refund.objects.select_for_update(of=("self",)).get(pk=refund_id)
    payment = (
        Payment.objects.select_for_update(of=("self",)).get(pk=refund.payment_id)
        if refund.payment_id
        else None
    )
    if payment is not None and refund.status == RefundStatus.DONE:
        close_if_fully_refunded(payment, now=refund.done_at or timezone.now())
    _record_status(refund, booking)


def close_if_fully_refunded(payment: Payment, *, now: datetime) -> bool:
    """PAID -> REFUNDED when the DONE refunds cover the whole payment. Caller holds the lock."""
    if payment.status != PaymentStatus.PAID:
        return False
    done = Refund.objects.filter(payment=payment, status=RefundStatus.DONE).aggregate(
        total=Sum("amount")
    )["total"] or Decimal(0)
    if done < payment.amount:
        return False
    lifecycle.set_payment_status(
        payment, PaymentStatus.REFUNDED, cancelled_at=payment.cancelled_at or now
    )
    return True


# --- the operator path for refunds a person must handle --------------------------------------


class Resolution(StrEnum):
    DONE = "done"  # the money was returned by hand (provider cabinet) or the check shows it was
    RETRY = "retry"  # FAILED only: send it to the provider again, from attempt 0
    FAILED = "failed"  # MANUAL only: it will not be refunded; the reservation is released


OPERATOR_NOTE_LENGTH = 200
OPERATOR_STATES = (RefundStatus.MANUAL, RefundStatus.FAILED)


@booking_services.retrying
@transaction.atomic
def resolve_manual_refund(
    refund_id, outcome: str, *, actor=None, note: str = "", now: datetime | None = None
) -> Refund:
    """A person settles a MANUAL or FAILED refund (admin UI in Step 11, ``resolve_refund`` command
    now). Same lock order as every payment writer (lot -> booking -> refund -> payment); refunds
    in flight (PENDING / SENT) or finished are refused, so this can never race a worker.

    * done:   MANUAL | FAILED -> DONE; the payment becomes REFUNDED once the DONE refunds cover it;
    * retry:  FAILED -> PENDING with attempts reset, queued on commit (needs a payment);
    * failed: MANUAL -> FAILED ("operator_failed") and the reserved amount goes back to the
      payment, so it can be refunded another way.
    Every resolution is a booking history line and an audit record."""
    resolution = Resolution(outcome)
    if actor is None:
        raise ValueError("An operator (actor) is required to resolve a refund.")
    note = clean_note(note)
    now = now or timezone.now()
    booking_id = Refund.objects.filter(pk=refund_id).values_list("booking_id", flat=True).first()
    if booking_id is None:
        raise NotFoundError("Refund not found.")
    booking_services.set_local_timeouts(conf.get_config().lock_timeout_seconds)
    _lot, booking = booking_services.lock_lot_and_booking(booking_id)
    refund = Refund.objects.select_for_update(of=("self",)).get(pk=refund_id)
    payment = (
        Payment.objects.select_for_update(of=("self",)).get(pk=refund.payment_id)
        if refund.payment_id
        else None
    )
    if refund.status not in OPERATOR_STATES:
        raise InvalidTransition(f"A {refund.status} refund cannot be resolved by hand.")
    if refund.status == RefundStatus.FAILED and refund.last_error == OPERATOR_FAILED:
        # Its reservation was returned to the payment: reviving it would refund the same money
        # twice. A new refund must be created instead.
        raise InvalidTransition("A refund the operator gave up on is final.")
    before = refund.status
    if resolution is Resolution.DONE:
        lifecycle.set_refund_status(
            refund, RefundStatus.DONE, done_at=now, last_error="", next_attempt_at=None
        )
        if payment is not None:
            close_if_fully_refunded(payment, now=now)
    elif resolution is Resolution.RETRY:
        if payment is None:
            raise InvalidTransition("A refund without a payment cannot be sent to a provider.")
        lifecycle.set_refund_status(
            refund, RefundStatus.PENDING, attempts=0, last_error="", next_attempt_at=None
        )
        transaction.on_commit(lambda: enqueue_refund(refund.pk))
    else:
        lifecycle.set_refund_status(refund, RefundStatus.FAILED, last_error=OPERATOR_FAILED)
        if payment is not None:
            payment.refunded_amount = payment.refunded_amount - refund.amount
            payment.save(update_fields=["refunded_amount", "updated_at"])
    if payment is not None:
        _assert_reservation(payment)
    meta = {
        "refund": str(refund.pk),
        "outcome": resolution.value,
        "note": note,
        "actor": str(actor.pk),
    }
    booking_services.log_booking_event(booking, reason="refund_resolved", meta=meta)
    audit(
        actor=actor,
        action="refund.resolve",
        obj_id=refund.pk,
        before={"status": before},
        after={"status": refund.status, "outcome": resolution.value, "note": note},
    )
    return refund


class ReservationMismatch(Conflict):
    default_detail = "The payment's refund reservation does not add up."
    default_code = "reservation_mismatch"


def _assert_reservation(payment: Payment) -> None:
    """Checked inside the operator's transaction: a mismatch rolls the whole resolution back."""
    payment.refresh_from_db(fields=["refunded_amount"])
    if reserved_total(payment) != payment.refunded_amount:
        logger.error("payment %s: refund reservation mismatch", payment.pk)
        raise ReservationMismatch


_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
_EMAIL = re.compile(r"[^\s@]+@[^\s@]+")
_HANDLE = re.compile(r"(?:^|[\s(\[,;:])@\w")
MAX_NOTE_DIGITS = 8


def clean_note(note: str) -> str:
    """The operator's note lands in the booking history and the audit log, so it must not carry
    personal data: control characters are removed; a note with nine or more digits in total (any
    separators, any scripts: a phone or card number), a '+' followed by a digit, an e-mail address
    or an @handle is refused. 200 characters at most."""
    note = re.sub(r"\s+", " ", _CONTROL.sub(" ", note or "")).strip()
    digits = re.sub(r"\D", "", note)
    if (
        len(digits) > MAX_NOTE_DIGITS
        or re.search(r"\+\s*\d", note)
        or _EMAIL.search(note)
        or _HANDLE.search(note)
    ):
        raise ValueError("The note looks like it contains personal data.")
    return note[:OPERATOR_NOTE_LENGTH]


def refund_ids_to_requeue(now: datetime) -> list[uuid.UUID]:
    cfg = conf.get_config()
    return selectors.refunds_to_requeue(now - cfg.stale, now, cfg.batch_limit)
