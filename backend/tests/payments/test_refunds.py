"""Refund creation (from a booking cancel) and delivery to the provider (Celery task logic)."""

from datetime import timedelta
from decimal import Decimal
from unittest import mock

import pytest
from celery.exceptions import Retry
from django.db import IntegrityError, transaction
from django.test import override_settings

from apps.bookings import services as booking_services
from apps.bookings.models import BookingEvent
from apps.payments import refunds, services, tasks
from apps.payments.models import Payment, PaymentStatus, Refund, RefundReason, RefundStatus
from tests.payments.factories import make_payment, make_refund, payme_id

pytestmark = pytest.mark.django_db

AMOUNT = Decimal("12000.00")


def paid(booking, now, provider="payme", provider_ref="555"):
    external_id = payme_id() if provider == "payme" else "910"
    payment = services.register_transaction(
        booking_id=booking.pk,
        provider=provider,
        external_id=external_id,
        amount=AMOUNT,
        now=now,
        provider_ref=provider_ref if provider == "click" else "",
    ).payment
    services.complete_payment(provider=provider, external_id=external_id, now=now)
    payment.refresh_from_db()
    booking.refresh_from_db()
    return payment


@pytest.fixture
def queued(monkeypatch):
    """Capture the Celery enqueue instead of talking to a broker."""
    calls = []
    monkeypatch.setattr(tasks.send_refund, "apply_async", lambda *a, **k: calls.append((a, k)))
    return calls


class TestCreateBookingRefund:
    def test_full_refund_on_early_cancel(
        self, booking, now, queued, django_capture_on_commit_callbacks
    ):
        payment = paid(booking, now)
        with django_capture_on_commit_callbacks(execute=True):
            booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        refund = Refund.objects.get()
        payment.refresh_from_db()
        assert refund.amount == AMOUNT
        assert refund.status == RefundStatus.PENDING
        assert refund.reason == RefundReason.BOOKING_CANCELLED
        assert refund.idempotency_key == f"cancel:{booking.pk}"
        assert refund.payment_id == payment.pk
        assert payment.refunded_amount == AMOUNT  # reserved so it cannot be refunded twice
        assert len(queued) == 1 and queued[0][0][0] == (str(refund.pk),)

    def test_half_refund_when_cancelled_in_the_last_hour(
        self, booking, now, queued, django_capture_on_commit_callbacks
    ):
        payment = paid(booking, now)
        with django_capture_on_commit_callbacks(execute=True):
            booking_services.cancel_booking(
                booking_id=booking.pk,
                user=booking.user,
                now=booking.starts_at - timedelta(minutes=30),
            )
        refund = Refund.objects.get()
        payment.refresh_from_db()
        assert refund.amount == Decimal("6000.00")
        assert payment.refunded_amount == Decimal("6000.00")
        assert payment.status == PaymentStatus.PAID  # only part of it is returned

    def test_no_refund_row_when_the_policy_refunds_nothing(self, booking, now, queued):
        paid(booking, now)
        booking_services.cancel_booking(
            booking_id=booking.pk, user=booking.user, now=booking.starts_at + timedelta(minutes=1)
        )
        assert not Refund.objects.exists()
        assert queued == []

    def test_cancelling_an_unpaid_booking_creates_nothing(self, booking, now, queued):
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        assert not Refund.objects.exists()

    def test_cancel_twice_creates_one_refund(self, booking, now, queued):
        paid(booking, now)
        for _ in range(3):
            booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        assert Refund.objects.count() == 1

    def test_creating_the_same_refund_twice_returns_the_first(self, booking, now, queued):
        paid(booking, now)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        booking.refresh_from_db()
        again = refunds.create_booking_refund(booking, Decimal("12000"))
        assert again.pk == Refund.objects.get().pk

    def test_amount_is_capped_by_what_the_payment_still_holds(self, booking, now, queued):
        payment = paid(booking, now)
        refund = refunds.create_booking_refund(booking, Decimal("99999"))
        assert refund.amount == AMOUNT
        payment.refresh_from_db()
        assert payment.refunded_amount == AMOUNT

    def test_a_rolled_back_cancel_leaves_no_refund_and_no_task(
        self, booking, now, queued, django_capture_on_commit_callbacks
    ):
        paid(booking, now)
        with (
            django_capture_on_commit_callbacks(execute=True),
            pytest.raises(RuntimeError),
            transaction.atomic(),
        ):
            booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
            raise RuntimeError("boom")
        assert not Refund.objects.exists()
        assert queued == []

    def test_a_paid_booking_without_any_payment_row_is_logged_not_crashed(
        self, booking, now, queued, caplog
    ):
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        manual = refunds.create_booking_refund(booking, Decimal("100"))
        assert manual.status == "MANUAL" and manual.payment_id is None
        assert any("no paid payment" in r.getMessage() for r in caplog.records)

    def test_history_gets_a_refund_event(self, booking, now, queued):
        paid(booking, now)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        assert BookingEvent.objects.filter(booking=booking, reason="refund_pending").exists()

    def test_refund_comes_from_the_payment_that_confirmed_the_booking(self, booking, now, queued):
        first = paid(booking, now, provider="payme")
        duplicate = make_payment(
            booking, provider="click", status=PaymentStatus.PAID, refunded_amount="12000"
        )
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        refund = Refund.objects.get()
        assert refund.payment_id == first.pk != duplicate.pk


class TestDatabaseGuards:
    def test_payment_refunded_amount_cannot_exceed_the_amount(self, booking):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        with pytest.raises(IntegrityError), transaction.atomic():
            Payment.objects.filter(pk=payment.pk).update(refunded_amount=AMOUNT + Decimal("0.01"))

    def test_refund_amount_must_be_positive(self, booking):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        with pytest.raises(IntegrityError), transaction.atomic():
            make_refund(payment, amount="0")

    def test_idempotency_key_is_unique(self, booking):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        make_refund(payment, key="k", amount="1")
        with pytest.raises(IntegrityError), transaction.atomic():
            make_refund(payment, key="k", amount="1")


def click_refund(booking, now, **kw):
    payment = paid(booking, now, provider="click", provider_ref="555")
    refund = make_refund(payment, amount=kw.pop("amount", AMOUNT), key=f"cancel:{booking.pk}")
    Payment.objects.filter(pk=payment.pk).update(refunded_amount=refund.amount)
    return payment, refund


class TestProcessRefund:
    def test_click_reversal_succeeds(self, booking, now, transport):
        payment, refund = click_refund(booking, now)
        outcome = refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        payment.refresh_from_db()
        assert outcome.retry_in is None
        assert refund.status == RefundStatus.DONE
        assert refund.attempts == 1 and refund.done_at == now
        assert payment.status == PaymentStatus.REFUNDED
        assert len(transport.calls) == 1
        call = transport.calls[0]
        assert call["method"] == "DELETE"
        assert call["url"].endswith("/payment/reversal/36/555")
        assert BookingEvent.objects.filter(booking=booking, reason="refund_done").exists()

    def test_a_refund_reaches_the_provider_only_once(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        refunds.process_refund(refund.pk, now=now)
        refunds.process_refund(refund.pk, now=now)
        refunds.process_refund(refund.pk, now=now)
        assert len(transport.calls) == 1

    def test_network_failure_is_retried_with_backoff(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        transport.push(error="timeout")
        first = refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        assert refund.status == RefundStatus.PENDING
        assert refund.attempts == 1 and refund.last_error == "timeout"
        assert first.retry_in == 30
        # still inside the backoff: a stray duplicate message does nothing
        assert refunds.process_refund(refund.pk, now=now + timedelta(seconds=5)).retry_in is None
        assert len(transport.calls) == 1
        transport.push(error="timeout")
        second = refunds.process_refund(refund.pk, now=now + timedelta(seconds=31))
        assert second.retry_in == 60
        refunds.process_refund(refund.pk, now=now + timedelta(seconds=100))  # default: success
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE and refund.attempts == 3
        assert refund.last_error == ""

    def test_backoff_is_capped_below_the_broker_visibility_timeout(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        Refund.objects.filter(pk=refund.pk).update(attempts=20)
        transport.push(error="timeout")
        with override_settings(PAYMENTS_REFUND_MAX_ATTEMPTS=50):
            outcome = refunds.process_refund(refund.pk, now=now)
        assert outcome.retry_in == 1800

    def test_giving_up_after_the_attempt_limit(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        with override_settings(PAYMENTS_REFUND_MAX_ATTEMPTS=2):
            transport.push(error="timeout")
            transport.push(error="timeout")
            refunds.process_refund(refund.pk, now=now)
            last = refunds.process_refund(refund.pk, now=now + timedelta(seconds=31))
        refund.refresh_from_db()
        assert last.retry_in is None
        assert refund.status == RefundStatus.FAILED
        assert refund.last_error == "retries_exhausted"
        assert BookingEvent.objects.filter(booking=booking, reason="refund_failed").exists()

    def test_http_5xx_is_retried(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        transport.push(status=502, data=None)
        outcome = refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        assert outcome.retry_in and refund.last_error == "http_502"

    def test_provider_error_code_is_final(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        transport.push(data={"error_code": -5, "error_note": "secret details"})
        outcome = refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        assert outcome.retry_in is None
        assert refund.status == RefundStatus.FAILED
        assert refund.last_error == "click_error_-5"
        assert "secret" not in refund.last_error

    def test_auth_failure_is_final(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        transport.push(status=401, data=None)
        refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        assert refund.status == RefundStatus.FAILED and refund.last_error == "http_401"

    def test_partial_refund_cannot_be_automated_with_click(self, booking, now, transport):
        payment, refund = click_refund(booking, now, amount="6000")
        refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        payment.refresh_from_db()
        assert refund.status == RefundStatus.MANUAL
        assert refund.last_error == "partial_refund_unsupported"
        assert transport.calls == []
        assert payment.status == PaymentStatus.PAID

    def test_payme_refunds_are_done_in_the_merchant_cabinet(self, booking, now, transport):
        payment = paid(booking, now, provider="payme")
        refund = make_refund(payment, key="cancel:x")
        refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        assert refund.status == RefundStatus.MANUAL
        assert refund.last_error == "payme_cabinet_refund"
        assert transport.calls == []
        assert BookingEvent.objects.filter(booking=booking, reason="refund_manual").exists()

    def test_unexpected_provider_exception_is_retried_without_leaking_it(
        self, booking, now, transport
    ):
        _, refund = click_refund(booking, now)
        with mock.patch(
            "apps.payments.providers.click.ClickProvider.refund",
            side_effect=RuntimeError("https://api.click.uz/secret-token-123"),
        ):
            outcome = refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        assert outcome.retry_in
        assert refund.last_error == "unexpected_error"

    def test_a_refund_in_flight_is_not_sent_again(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        Refund.objects.filter(pk=refund.pk).update(
            status=RefundStatus.SENT, next_attempt_at=now + timedelta(minutes=2)
        )
        refunds.process_refund(refund.pk, now=now)
        assert transport.calls == []

    def test_unknown_refund_is_ignored(self, now):
        import uuid

        outcome = refunds.process_refund(uuid.uuid4(), now=now)
        assert outcome.refund is None and outcome.retry_in is None

    def test_partially_refunded_payment_stays_paid_after_a_successful_partial(
        self, booking, now, transport
    ):
        """Partial reversal is not automated, so DONE-but-partial can only come from the provider;
        the payment becomes REFUNDED only when everything is returned."""
        payment = paid(booking, now, provider="payme")
        refund = make_refund(payment, amount="6000", key="cancel:y")
        Payment.objects.filter(pk=payment.pk).update(refunded_amount=Decimal("6000"))
        with mock.patch(
            "apps.payments.providers.payme.PaymeProvider.refund",
            return_value=refunds.RefundResult(refunds.ResultKind.DONE, provider_ref="r1"),
        ):
            refunds.process_refund(refund.pk, now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.PAID


class TestSendRefundTask:
    def test_task_retries_when_the_service_asks_for_it(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        transport.push(error="timeout")
        with pytest.raises(Retry):
            tasks.send_refund.run(str(refund.pk))

    def test_task_finishes_quietly_on_success(self, booking, now, transport):
        _, refund = click_refund(booking, now)
        assert tasks.send_refund.run(str(refund.pk)) == "DONE"

    def test_task_is_registered_under_its_documented_name(self):
        assert tasks.send_refund.name == "payments.send_refund"
