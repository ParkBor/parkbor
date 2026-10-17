"""A cancelled paid booking must NEVER end without a refund record (no silent money loss)."""

from datetime import timedelta
from decimal import Decimal

import pytest

from apps.bookings import hooks
from apps.bookings import services as booking_services
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.bookings.state import status_write_allowed
from apps.core.exceptions import ApiError
from apps.payments import reconcile, refunds, services
from apps.payments.models import Payment, PaymentStatus, Refund, RefundStatus
from tests.payments.factories import make_payment, payme_id

pytestmark = pytest.mark.django_db
AMOUNT = Decimal("12000.00")


def paid(booking, now, provider="payme"):
    payment = services.register_transaction(
        booking_id=booking.pk, provider=provider, external_id=payme_id(), amount=AMOUNT, now=now
    ).payment
    services.complete_payment(provider=provider, external_id=payment.external_id, now=now)
    booking.refresh_from_db()
    return payment


def confirmed_without_payment(booking):
    """What a legacy / hand-repaired booking looks like: CONFIRMED and paid, but no Payment row."""
    with status_write_allowed():
        Booking.objects.filter(pk=booking.pk).update(status=S.CONFIRMED, paid_amount=AMOUNT)
    booking.refresh_from_db()


class TestHandlerMissing:
    def test_cancel_fails_closed_and_rolls_back_when_no_refund_handler_is_registered(
        self, booking, now, monkeypatch
    ):
        paid(booking, now)
        monkeypatch.setattr(hooks, "_refund_handler", None)
        with pytest.raises(ApiError) as caught:
            booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        assert caught.value.status_code == 503
        assert str(caught.value.detail["code"]) == "refund_handler_missing"
        booking.refresh_from_db()
        assert booking.status == S.CONFIRMED and booking.refund_amount == 0  # nothing half-done
        assert not Refund.objects.exists()

    def test_an_unpaid_cancel_does_not_need_the_handler(self, booking, now, monkeypatch):
        monkeypatch.setattr(hooks, "_refund_handler", None)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        assert Booking.objects.get(pk=booking.pk).status == S.CANCELLED

    def test_the_payments_app_registers_the_handler_when_it_starts(self):
        assert hooks._refund_handler is refunds.create_booking_refund

    def test_api_answers_503_not_a_200_with_a_lost_refund(self, booking, now, monkeypatch):
        from tests.helpers import client_for

        paid(booking, now)
        monkeypatch.setattr(hooks, "_refund_handler", None)
        response = client_for(booking.user).post(f"/api/v1/bookings/{booking.pk}/cancel")
        assert response.status_code == 503
        assert response.json()["code"] == "refund_handler_missing"


class TestNoPaymentToRefundFrom:
    def test_a_manual_refund_record_is_written_instead_of_nothing(self, booking, now):
        confirmed_without_payment(booking)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        refund = Refund.objects.get()
        assert refund.payment_id is None
        assert refund.status == RefundStatus.MANUAL
        assert refund.amount == AMOUNT
        assert refund.last_error == "no_paid_payment"
        assert refund.idempotency_key == f"cancel:{booking.pk}"
        assert BookingEvent.objects.filter(booking=booking, reason="refund_manual").exists()

    def test_the_booking_shows_it_as_manual(self, booking, now):
        from apps.payments.checkout import refund_status_for

        confirmed_without_payment(booking)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        assert refund_status_for(Booking.objects.get(pk=booking.pk)) == "manual"

    def test_a_manual_refund_without_a_payment_is_never_sent_to_a_provider(self, booking, now):
        confirmed_without_payment(booking)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        refund = Refund.objects.get()
        assert refunds.process_refund(refund.pk, now=now).retry_in is None
        refund.refresh_from_db()
        assert refund.status == RefundStatus.MANUAL and refund.attempts == 0

    def test_only_manual_or_done_refunds_may_lack_a_payment(self, booking):
        from django.db import IntegrityError, transaction

        with pytest.raises(IntegrityError), transaction.atomic():
            Refund.objects.create(
                payment=None,
                booking=booking,
                amount=1,
                status=RefundStatus.PENDING,
                reason="booking_cancelled",
                idempotency_key="x",
            )

    def test_the_shortfall_beyond_what_the_payments_hold_is_recorded_too(self, booking, now):
        payment = paid(booking, now)
        Payment.objects.filter(pk=payment.pk).update(refunded_amount=Decimal("4000"))
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        automatic = Refund.objects.get(idempotency_key=f"cancel:{booking.pk}")
        shortfall = Refund.objects.get(idempotency_key=f"cancel:{booking.pk}:shortfall")
        assert automatic.amount == Decimal("8000.00") and automatic.payment_id == payment.pk
        assert shortfall.amount == Decimal("4000.00")
        assert shortfall.status == RefundStatus.MANUAL and shortfall.payment_id is None
        assert automatic.amount + shortfall.amount == AMOUNT


class TestSweepRepairsMissingRefunds:
    def cancelled_without_refund(self, booking, now, with_payment):
        if with_payment:
            paid(booking, now)
        else:
            confirmed_without_payment(booking)
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(
                status=S.CANCELLED,
                refund_amount=AMOUNT,
                cancelled_at=now - timedelta(hours=1),
            )

    def test_a_cancelled_booking_with_a_promised_refund_and_no_record_gets_one(self, booking, now):
        self.cancelled_without_refund(booking, now, with_payment=True)
        stats = reconcile.run(now=now)
        refund = Refund.objects.get()
        assert stats["orphan_refund_missing"] == 1
        assert refund.payment is not None and refund.amount == AMOUNT

    def test_without_any_payment_it_becomes_a_manual_record_and_an_error_log(
        self, booking, now, caplog
    ):
        self.cancelled_without_refund(booking, now, with_payment=False)
        stats = reconcile.run(now=now)
        refund = Refund.objects.get()
        assert stats["orphan_refund_missing"] == 1
        assert refund.status == RefundStatus.MANUAL and refund.payment_id is None
        assert any(
            r.levelname == "ERROR" and str(booking.pk) in r.getMessage() for r in caplog.records
        )

    def test_running_again_creates_nothing_new(self, booking, now):
        self.cancelled_without_refund(booking, now, with_payment=False)
        reconcile.run(now=now)
        stats = reconcile.run(now=now)
        assert Refund.objects.count() == 1 and stats["orphan_refund_missing"] == 0

    def test_bookings_that_promised_nothing_are_ignored(self, booking, now):
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=S.CANCELLED)
        assert reconcile.run(now=now)["orphan_refund_missing"] == 0

    def test_young_cancellations_are_left_to_their_own_transaction(self, booking, now):
        """cancel_booking commits the refund together with the cancel; the sweep only looks at
        cancellations older than the stale threshold, so it never races a running cancel."""
        self.cancelled_without_refund(booking, now, with_payment=False)
        Booking.objects.filter(pk=booking.pk).update(cancelled_at=now + timedelta(seconds=1))
        assert reconcile.run(now=now)["orphan_refund_missing"] == 0

    def test_payment_helper_is_importable(self, booking):
        assert make_payment(booking, status=PaymentStatus.PAID)
