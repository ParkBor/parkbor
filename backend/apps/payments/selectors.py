"""Read queries of the payments app."""

import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from django.db.models import F, Q, QuerySet, Sum

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus

from .models import Payment, PaymentStatus, Refund, RefundStatus


def booking_id_of_payment(provider: str, external_id: str) -> uuid.UUID | None:
    return (
        Payment.objects.filter(provider=provider, external_id=external_id)
        .values_list("booking_id", flat=True)
        .first()
    )


def get_payment(provider: str, external_id: str) -> Payment | None:
    return Payment.objects.filter(provider=provider, external_id=external_id).first()


def get_click_payment_by_id(payment_id: uuid.UUID) -> Payment | None:
    """Click's ``merchant_prepare_id`` is our payment id."""
    return Payment.objects.filter(pk=payment_id, provider="click").first()


def payme_statement(from_ms: int, to_ms: int, limit: int) -> list[Payment]:
    """Payme transactions created between the two instants (inclusive), oldest first. Searched by
    Payme's own creation time (``params.time`` of CreateTransaction)."""
    return list(
        Payment.objects.filter(
            provider="payme", provider_time__gte=from_ms, provider_time__lte=to_ms
        ).order_by("provider_time", "created_at", "id")[:limit]
    )


def paid_payments_for_refund(booking) -> list[Payment]:
    """PAID payments of the booking that still hold money to give back, earliest first."""
    queryset = Payment.objects.filter(booking=booking, status=PaymentStatus.PAID)
    queryset = queryset.filter(refunded_amount__lt=F("amount"))
    return list(queryset.order_by(F("performed_at").asc(nulls_last=True), "created_at", "id"))


def stale_pending_payments(older_than: datetime, limit: int) -> QuerySet[Payment]:
    return Payment.objects.filter(status=PaymentStatus.PENDING, created_at__lt=older_than).order_by(
        "created_at", "id"
    )[:limit]


ORPHAN_LOOKBACK = timedelta(days=7)


def orphan_paid_payment_ids(now: datetime, limit: int) -> list[uuid.UUID]:
    """PAID payments that never confirmed their booking (it is EXPIRED / CANCELLED with nothing
    collected) and have no refund yet: the "paid after cancel/expire" safety net."""
    queryset = Payment.objects.filter(
        status=PaymentStatus.PAID,
        performed_at__gt=now - ORPHAN_LOOKBACK,  # bounded scan (partial index payment_paid_open)
        refunds__isnull=True,
        refunded_amount=0,
        booking__status__in=(BookingStatus.EXPIRED, BookingStatus.CANCELLED),
        booking__paid_amount=0,
    )
    return list(queryset.order_by("created_at", "id").values_list("pk", flat=True)[:limit])


def refunds_to_requeue(older_than: datetime, now: datetime, limit: int) -> list[uuid.UUID]:
    """PENDING refunds nobody is working on (lost task) and SENT ones whose lease ran out."""
    pending = Refund.objects.filter(status=RefundStatus.PENDING, updated_at__lt=older_than).filter(
        Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now)  # not waiting out a backoff
    )
    sent = Refund.objects.filter(status=RefundStatus.SENT, next_attempt_at__lt=now)
    half = max(limit // 2, 1)  # neither kind may starve the other
    ids = list(pending.values_list("pk", flat=True)[:half])
    ids += list(sent.values_list("pk", flat=True)[: limit - len(ids)])
    if len(ids) < limit:
        ids += [
            pk
            for pk in pending.values_list("pk", flat=True)[: limit - len(ids) + half]
            if pk not in ids
        ][: limit - len(ids)]
    return ids


def refunds_needing_attention(older_than: datetime, limit: int) -> list[Refund]:
    """MANUAL (a person must refund in the provider's cabinet) and FAILED refunds that have waited
    longer than the alert threshold. The operator list of Step 11 reads this."""
    return list(
        Refund.objects.filter(
            status__in=(RefundStatus.MANUAL, RefundStatus.FAILED), updated_at__lt=older_than
        ).order_by("updated_at", "id")[:limit]
    )


def payments_with_done_refunds(limit: int) -> list[uuid.UUID]:
    """PAID payments whose DONE refunds already cover the whole amount: they should be REFUNDED
    (repair after a crash). Partially refunded payments are not candidates, so they cannot
    crowd real ones out of the batch."""
    queryset = (
        Payment.objects.filter(status=PaymentStatus.PAID)
        .annotate(done=Sum("refunds__amount", filter=Q(refunds__status=RefundStatus.DONE)))
        .filter(done__gte=F("amount"))
    )
    return list(queryset.order_by("created_at", "id").values_list("pk", flat=True)[:limit])


def cancelled_without_refund_ids(older_than: datetime, limit: int) -> list[uuid.UUID]:
    """CANCELLED bookings that promise a refund (``refund_amount > 0``) but have no Refund row at
    all: the "money silently lost" invariant violation. Only cancellations older than the
    threshold, so a cancel still committing is never raced."""
    return list(
        Booking.objects.filter(
            status=BookingStatus.CANCELLED,
            refund_amount__gt=0,
            refunds__isnull=True,
            cancelled_at__lt=older_than,
        )
        .order_by("cancelled_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


def payments_with_reservation_mismatch(since: datetime, limit: int) -> list[uuid.UUID]:
    """Payments whose ``refunded_amount`` differs from what their refunds hold back (the reserve
    invariant), among those with a refund touched since ``since``. Any hit is a bug or a hand
    edit: it is reported, never auto-corrected (money is involved)."""
    from django.db.models.functions import Coalesce

    holding = ~Q(refunds__status=RefundStatus.FAILED, refunds__last_error="operator_failed")
    queryset = (
        Payment.objects.filter(refunds__updated_at__gt=since)
        .annotate(reserved=Coalesce(Sum("refunds__amount", filter=holding), Decimal(0)))
        .exclude(reserved=F("refunded_amount"))
    )
    return list(
        queryset.order_by("created_at", "id").values_list("pk", flat=True).distinct()[:limit]
    )
