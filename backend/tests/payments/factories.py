"""Builders and fakes for payment tests."""

import itertools
from decimal import Decimal

from apps.payments.models import Payment, PaymentStatus, Refund, RefundStatus

_ids = itertools.count(1)


def payme_id() -> str:
    """A 24-character Payme-style transaction id, unique per call."""
    return f"{next(_ids):024x}"


def make_payment(
    booking,
    *,
    provider="payme",
    external_id=None,
    status=PaymentStatus.PENDING,
    amount=None,
    provider_ref="",
    provider_time=None,
    performed_at=None,
    cancelled_at=None,
    refunded_amount="0",
    raw_state=None,
) -> Payment:
    return Payment.objects.create(
        booking=booking,
        provider=provider,
        external_id=external_id or (payme_id() if provider == "payme" else str(next(_ids))),
        provider_ref=provider_ref,
        amount=Decimal(amount) if amount is not None else booking.amount,
        status=status,
        provider_time=provider_time,
        performed_at=performed_at,
        cancelled_at=cancelled_at,
        refunded_amount=Decimal(refunded_amount),
        raw_state=raw_state or {},
    )


def make_refund(payment, *, amount=None, status=RefundStatus.PENDING, key=None, **extra) -> Refund:
    return Refund.objects.create(
        payment=payment,
        booking=payment.booking,
        amount=Decimal(amount) if amount is not None else payment.amount,
        status=status,
        reason=extra.pop("reason", "booking_cancelled"),
        idempotency_key=key or f"test:{next(_ids)}",
        **extra,
    )


class FakeTransport:
    """Records outgoing provider API calls and answers from a queue (or a default success)."""

    def __init__(self):
        self.calls = []
        self.queue = []

    def push(self, status=200, data=None, error=None):
        self.queue.append((status, data, error))

    def request(self, method, url, *, headers, timeout):
        from apps.payments.providers.http import HttpResult, TransportError

        self.calls.append({"method": method, "url": url, "headers": dict(headers)})
        if self.queue:
            status, data, error = self.queue.pop(0)
        else:
            status, data, error = 200, {"error_code": 0, "error_note": "Success"}, None
        if error:
            raise TransportError(error)
        return HttpResult(status=status, data=data)
