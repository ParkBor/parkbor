"""Payment lifecycle driven by provider callbacks (status writes go through ``lifecycle``).

Locking (ARCHITECTURE 7.1 / 10.8, mandatory): every write first locks the parking LOT of the
booking, then the booking row, then the payment row. That is the booking order (lot -> ... ->
booking) with the payment appended last, so a webhook can never deadlock with create / cancel /
expire / check-in. Each public function is ONE transaction under the booking deadlock retry
(40P01 once, then 503); a failure leaves business state exactly as it was.

Money rule: a payment is accepted for a booking that is still PENDING_PAYMENT, even if its hold
ran out but the sweep has not expired it yet (the slot is still that booking's and the money is
on its way). Once the booking is EXPIRED / CANCELLED it is refused, or - when the provider's
protocol forbids refusing (Click Complete) - accepted and refunded automatically.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from django.db import IntegrityError, transaction

from apps.bookings import services as booking_services
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus
from apps.core.exceptions import NotFoundError

from . import conf, errors, lifecycle, refunds, selectors
from .models import Payment, PaymentStatus, RefundReason

logger = logging.getLogger(__name__)

PAID_BOOKING_STATUSES = frozenset(
    {
        BookingStatus.CONFIRMED,
        BookingStatus.ACTIVE,
        BookingStatus.OVERSTAY,
        BookingStatus.COMPLETED,
        BookingStatus.NO_SHOW,
    }
)
USED_BOOKING_STATUSES = frozenset(
    {BookingStatus.ACTIVE, BookingStatus.OVERSTAY, BookingStatus.COMPLETED}
)


class CompleteOutcome(StrEnum):
    PAID = "PAID"
    ALREADY_PAID = "ALREADY_PAID"
    PAID_AND_REFUNDING = "PAID_AND_REFUNDING"


@dataclass(frozen=True)
class Registered:
    payment: Payment
    created: bool


@dataclass(frozen=True)
class Completed:
    payment: Payment
    outcome: CompleteOutcome


@dataclass(frozen=True)
class Cancelled:
    payment: Payment
    was_performed: bool


# --- helpers --------------------------------------------------------------------------------


def _as_uuid(value) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def _lock_order(booking_id) -> Booking:
    """Lot lock, then the booking row (the shared lock order). OrderNotFound if it is gone."""
    booking_services.set_local_timeouts(conf.get_config().lock_timeout_seconds)
    try:
        _lot, booking = booking_services.lock_lot_and_booking(booking_id)
    except NotFoundError as exc:
        raise errors.OrderNotFound from exc
    return booking


def _assert_payable(booking: Booking, now: datetime) -> None:
    if booking.status in PAID_BOOKING_STATUSES:
        raise errors.OrderAlreadyPaid
    if booking.status != BookingStatus.PENDING_PAYMENT:
        raise errors.OrderNotPayable
    if booking.hold_expires_at is None or booking.hold_expires_at <= now:
        raise errors.OrderNotPayable


def _locked_payment(provider: str, external_id: str) -> Payment | None:
    return (
        Payment.objects.select_for_update(of=("self",))
        .filter(provider=provider, external_id=external_id)
        .first()
    )


def _event(booking: Booking, reason: str, payment: Payment, **meta) -> None:
    booking_services.log_booking_event(
        booking,
        reason=reason,
        meta={"payment": str(payment.pk), "provider": payment.provider, **meta},
    )


# --- order check (CheckPerformTransaction / Click Prepare pre-check) --------------------------


def check_order(booking_id, amount: Decimal, *, now: datetime) -> Booking:
    """Read-only: can ``booking_id`` take a payment of ``amount`` right now? Order of the checks
    follows the Payme sandbox: the account first, then its state, then the amount."""
    booking = Booking.objects.select_related("slot__zone").filter(pk=_as_uuid(booking_id)).first()
    if booking is None:
        raise errors.OrderNotFound
    _assert_payable(booking, now)
    if booking.amount != amount:
        raise errors.AmountMismatch
    return booking


# --- a provider transaction appears ------------------------------------------------------------


@booking_services.retrying
@transaction.atomic
def register_transaction(
    *,
    booking_id,
    provider: str,
    external_id: str,
    amount: Decimal,
    now: datetime,
    provider_time: int | None = None,
    provider_ref: str = "",
    supersede: bool = False,
) -> Registered:
    """Record the provider's transaction for a payable booking (Payme CreateTransaction, Click
    Prepare). Idempotent on ``(provider, external_id)``. ``supersede`` cancels an older open
    transaction of the same provider (a new Click attempt) instead of refusing."""
    booking_id = _as_uuid(booking_id)
    known = selectors.booking_id_of_payment(provider, external_id)
    if known is not None and known != booking_id:
        raise errors.ConflictingTransaction
    booking = _lock_order(booking_id)
    existing = _locked_payment(provider, external_id)
    if existing is not None:
        if existing.booking_id != booking.pk:
            raise errors.ConflictingTransaction
        if existing.amount != amount:
            raise errors.AmountMismatch
        return Registered(existing, created=False)
    _assert_payable(booking, now)
    if booking.amount != amount:
        raise errors.AmountMismatch
    _close_open_transactions(booking, provider, now, supersede=supersede)
    try:
        with transaction.atomic():
            payment = lifecycle.create_payment(
                booking=booking,
                provider=provider,
                external_id=external_id,
                provider_ref=provider_ref,
                amount=amount,
                provider_time=provider_time,
            )
    except IntegrityError:
        # Lost a race on (provider, external_id) to a request for ANOTHER booking.
        winner = selectors.get_payment(provider, external_id)
        if winner is not None and winner.booking_id == booking.pk and winner.amount == amount:
            return Registered(winner, created=False)
        raise errors.ConflictingTransaction from None
    booking_services.extend_hold_for_payment(booking, now=now, grace=conf.get_config().hold_grace)
    _event(booking, "payment_pending", payment)
    return Registered(payment, created=True)


def _close_open_transactions(booking: Booking, provider: str, now: datetime, *, supersede: bool):
    open_payments = list(
        Payment.objects.select_for_update(of=("self",)).filter(
            booking=booking, provider=provider, status=PaymentStatus.PENDING
        )
    )
    if not open_payments:
        return
    if not supersede:
        raise errors.ConflictingTransaction
    for old in open_payments:
        lifecycle.set_payment_status(
            old,
            PaymentStatus.CANCELLED,
            cancelled_at=now,
            raw_state={**old.raw_state, "superseded": True},
        )


# --- the money arrives -------------------------------------------------------------------------


@booking_services.retrying
@transaction.atomic
def complete_payment(
    *,
    provider: str,
    external_id: str,
    now: datetime,
    accept_unpayable: bool = False,
    provider_ref: str = "",
) -> Completed:
    """The provider took the money (Payme PerformTransaction, Click Complete).

    PENDING + booking PENDING_PAYMENT -> booking CONFIRMED (``paid_amount`` = the payment) and
    the payment PAID, atomically. ``accept_unpayable``: when the booking can no longer take the
    money (cancelled, expired, or already paid by another payment) and the protocol forbids
    refusing, the payment is recorded PAID and a refund is created at once (nothing is ever kept).
    """
    booking_id = selectors.booking_id_of_payment(provider, external_id)
    if booking_id is None:
        raise errors.TransactionNotFound
    booking = _lock_order(booking_id)
    payment = _locked_payment(provider, external_id)
    if payment is None:  # deleted between the two reads: cannot happen (PROTECT), be safe
        raise errors.TransactionNotFound
    if payment.status == PaymentStatus.PAID:
        return Completed(payment, CompleteOutcome.ALREADY_PAID)
    if payment.status != PaymentStatus.PENDING:
        raise errors.TransactionStateError
    if booking.status == BookingStatus.PENDING_PAYMENT and booking.amount == payment.amount:
        booking_services.confirm_locked(booking, paid_amount=payment.amount)
        _mark_paid(payment, now, provider_ref)
        return Completed(payment, CompleteOutcome.PAID)
    if not accept_unpayable:
        raise errors.OrderNotPayable
    _mark_paid(payment, now, provider_ref)
    reason = (
        RefundReason.DUPLICATE
        if booking.status in PAID_BOOKING_STATUSES
        else RefundReason.UNPAID_BOOKING
    )
    refunds.create_auto_refund(payment, reason, now=now)
    return Completed(payment, CompleteOutcome.PAID_AND_REFUNDING)


def _mark_paid(payment: Payment, now: datetime, provider_ref: str = "") -> None:
    fields = {"performed_at": now}
    if provider_ref and not payment.provider_ref:
        fields["provider_ref"] = provider_ref  # e.g. Click click_paydoc_id, needed for reversal
    lifecycle.set_payment_status(payment, PaymentStatus.PAID, **fields)


# --- a transaction is cancelled -------------------------------------------------------------


@booking_services.retrying
@transaction.atomic
def cancel_transaction(
    *, provider: str, external_id: str, now: datetime, raw: dict | None = None
) -> Cancelled:
    """Cancel a provider transaction (Payme CancelTransaction, Click Complete with error < 0).

    * PENDING -> CANCELLED (the booking stays open: the driver may pay again);
    * PAID -> the provider returned the money on its side: payment REFUNDED, a CONFIRMED booking
      is cancelled, a refund we were waiting for is settled. Refused (OrderCompleted) once the
      booking is in use (ACTIVE / OVERSTAY / COMPLETED): the service was provided;
    * already cancelled / refunded -> returned as is (idempotent).
    """
    booking_id = selectors.booking_id_of_payment(provider, external_id)
    if booking_id is None:
        raise errors.TransactionNotFound
    booking = _lock_order(booking_id)
    payment = _locked_payment(provider, external_id)
    if payment is None:
        raise errors.TransactionNotFound
    if payment.status in (PaymentStatus.CANCELLED, PaymentStatus.FAILED):
        return Cancelled(payment, was_performed=False)
    if payment.status == PaymentStatus.REFUNDED:
        return Cancelled(payment, was_performed=True)
    if payment.status != PaymentStatus.PAID:
        lifecycle.set_payment_status(
            payment,
            PaymentStatus.CANCELLED,
            cancelled_at=now,
            raw_state={**payment.raw_state, **(raw or {})},
        )
        _event(booking, "payment_cancelled", payment)
        return Cancelled(payment, was_performed=False)
    _refund_performed(payment, booking, now, raw or {})
    return Cancelled(payment, was_performed=True)


def _refund_performed(payment: Payment, booking: Booking, now: datetime, raw: dict) -> None:
    if booking.status in USED_BOOKING_STATUSES:
        raise errors.OrderCompleted
    if booking.status == BookingStatus.CONFIRMED:
        booking_services.cancel_after_provider_refund(booking, now=now)
    lifecycle.set_payment_status(
        payment,
        PaymentStatus.REFUNDED,
        refunded_amount=payment.amount,
        cancelled_at=now,
        raw_state={**payment.raw_state, **raw},
    )
    refunds.settle_by_provider(payment, booking, now=now)
