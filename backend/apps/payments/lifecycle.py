"""The ONLY module that writes ``Payment.status`` / ``Refund.status`` (a lint test enforces it,
like ``Booking.status`` and ``bookings/services.py``). Every write goes through a transition
table; the refund attempt writes are FENCED (conditional UPDATEs), so a slow or crashed worker can
never overwrite a newer state.
"""

from datetime import datetime, timedelta

from django.db import transaction
from django.db.models import F, Q

from apps.core.exceptions import InvalidTransition

from .models import Payment, PaymentStatus, Refund, RefundStatus

P, R = PaymentStatus, RefundStatus

PAYMENT_TRANSITIONS: dict[str, frozenset[str]] = {
    P.CREATED: frozenset({P.PENDING, P.CANCELLED, P.FAILED}),
    P.PENDING: frozenset({P.PAID, P.CANCELLED, P.FAILED}),
    P.PAID: frozenset({P.REFUNDED}),
    P.CANCELLED: frozenset(),
    P.REFUNDED: frozenset(),
    P.FAILED: frozenset(),
}
REFUND_TRANSITIONS: dict[str, frozenset[str]] = {
    R.PENDING: frozenset({R.SENT, R.DONE, R.MANUAL, R.FAILED}),
    R.SENT: frozenset({R.PENDING, R.DONE, R.MANUAL, R.FAILED}),
    # MANUAL -> DONE: provider/operator settled it. MANUAL -> FAILED: the operator decided it will
    # not be refunded. FAILED -> DONE / PENDING: the operator checked and fixed / wants a retry.
    R.MANUAL: frozenset({R.DONE, R.FAILED}),
    R.DONE: frozenset(),
    R.FAILED: frozenset({R.DONE, R.PENDING}),
}


def _assert(table: dict, source: str, target: str) -> None:
    if target not in table.get(source, frozenset()):
        raise InvalidTransition(f"Cannot change from {source} to {target}.")


def set_payment_status(payment: Payment, to: str, **fields) -> Payment:
    """Move a payment (row locked by the caller) along the table; extra ``fields`` are saved
    in the same write."""
    _assert(PAYMENT_TRANSITIONS, payment.status, to)
    payment.status = to
    for name, value in fields.items():
        setattr(payment, name, value)
    payment.save(update_fields=["status", "updated_at", *fields])
    return payment


def set_refund_status(refund: Refund, to: str, **fields) -> Refund:
    """Move a refund (row locked by the caller) along the table."""
    _assert(REFUND_TRANSITIONS, refund.status, to)
    refund.status = to
    for name, value in fields.items():
        setattr(refund, name, value)
    refund.save(update_fields=["status", "updated_at", *fields])
    return refund


def create_payment(**fields) -> Payment:
    """A new provider transaction, always born PENDING (the only creation path)."""
    return Payment.objects.create(status=P.PENDING, **fields)


def create_refund(*, status: str = R.PENDING, **fields) -> Refund:
    """A new refund row. Born PENDING (to be sent), or MANUAL / DONE for money that is settled
    by a person or by the provider; nothing else may be created."""
    if status not in (R.PENDING, R.MANUAL, R.DONE):
        raise InvalidTransition(f"A refund cannot be created {status}.")
    return Refund.objects.create(status=status, **fields)


# --- fenced refund attempts (no booking / lot lock needed: one conditional UPDATE each) ----------


@transaction.atomic
def claim_refund(refund_id, *, now: datetime, lease: timedelta) -> int | None:
    """PENDING (backoff over) or SENT (lease over) -> SENT with ``attempts + 1``; returns the new
    attempt number (the fencing token) or None if somebody else owns the refund / it is waiting
    out a backoff / it is finished. Atomic in the database: two workers cannot both win."""
    waiting_ok = Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now)
    claimable = Q(status__in=(R.PENDING, R.SENT)) & waiting_ok  # a SENT lease also lives here
    changed = Refund.objects.filter(claimable, pk=refund_id).update(
        status=R.SENT, attempts=F("attempts") + 1, next_attempt_at=now + lease, updated_at=now
    )
    if changed != 1:
        return None
    return Refund.objects.select_for_update().values_list("attempts", flat=True).get(pk=refund_id)


def finish_refund_attempt(
    refund_id,
    attempts: int,
    *,
    to: str,
    now: datetime,
    provider_ref: str = "",
    last_error: str = "",
    next_attempt_at: datetime | None = None,
) -> bool:
    """Record the result of attempt ``attempts``. Applies only if the refund is still SENT *by that
    attempt*: a late result of an abandoned attempt (lease expired, someone re-claimed, the
    provider settled it) is discarded and False is returned."""
    _assert(REFUND_TRANSITIONS, R.SENT, to)
    values = {
        "status": to,
        "last_error": last_error[:120],
        "next_attempt_at": next_attempt_at,
        "updated_at": now,
    }
    if provider_ref:
        values["provider_ref"] = provider_ref
    if to == R.DONE:
        values["done_at"] = now
    changed = Refund.objects.filter(pk=refund_id, status=R.SENT, attempts=attempts).update(**values)
    return changed == 1
