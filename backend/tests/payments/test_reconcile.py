"""retry_failed_webhooks (ARCHITECTURE 16): payments / refunds that never reached an end."""

from datetime import timedelta
from unittest import mock

import pytest
from django.test import override_settings

from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.bookings.state import status_write_allowed
from apps.payments import reconcile, tasks
from apps.payments.models import Payment, PaymentStatus, Refund, RefundReason, RefundStatus
from tests.payments.factories import make_payment, make_refund

pytestmark = pytest.mark.django_db


def kill(booking, status=S.EXPIRED, **fields):
    with status_write_allowed():
        Booking.objects.filter(pk=booking.pk).update(status=status, **fields)
    booking.refresh_from_db()


def age(model, pk, minutes):
    """Make a row look `minutes` old (auto_now_add cannot be set through create)."""
    from django.utils import timezone

    model.objects.filter(pk=pk).update(created_at=timezone.now() - timedelta(minutes=minutes))


@pytest.fixture
def queued(monkeypatch):
    calls = []
    monkeypatch.setattr(tasks.send_refund, "apply_async", lambda *a, **k: calls.append(a[0][0]))
    return calls


class TestOrphanPending:
    def test_pending_payment_of_a_dead_booking_is_cancelled(self, booking, now):
        payment = make_payment(booking, provider="click", external_id="1")
        age(Payment, payment.pk, 60)
        kill(booking)
        stats = reconcile.run(now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.CANCELLED
        assert payment.raw_state["orphan"] is True
        assert payment.cancelled_at == now
        assert stats["orphans_cancelled"] == 1
        assert BookingEvent.objects.filter(booking=booking, reason="payment_cancelled").exists()

    def test_payme_orphans_carry_the_timeout_reason(self, booking, now):
        payment = make_payment(booking)
        age(Payment, payment.pk, 60)
        kill(booking)
        reconcile.run(now=now)
        payment.refresh_from_db()
        assert payment.raw_state["reason"] == 4

    def test_payment_of_a_live_booking_is_left_alone(self, booking, now):
        payment = make_payment(booking)
        age(Payment, payment.pk, 60)
        stats = reconcile.run(now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.PENDING
        assert stats["orphans_cancelled"] == 0
        assert stats["stale_pending"] == 1  # reported, because it is old

    def test_young_payments_are_not_touched_even_if_the_booking_died(self, booking, now):
        payment = make_payment(booking)
        kill(booking)
        reconcile.run(now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.PENDING

    def test_hold_that_ran_out_but_is_inside_the_grace_keeps_the_payment(self, booking, now):
        payment = make_payment(booking)
        age(Payment, payment.pk, 60)
        Booking.objects.filter(pk=booking.pk).update(hold_expires_at=now - timedelta(minutes=2))
        reconcile.run(now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.PENDING

    def test_hold_long_gone_cancels_the_payment_even_if_the_sweep_is_late(self, booking, now):
        payment = make_payment(booking)
        age(Payment, payment.pk, 60)
        Booking.objects.filter(pk=booking.pk).update(hold_expires_at=now - timedelta(minutes=30))
        reconcile.run(now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.CANCELLED


class TestPaidAfterTheBookingDied:
    def test_paid_payment_of_an_expired_booking_is_refunded(self, booking, now, queued):
        payment = make_payment(booking, status=PaymentStatus.PAID, performed_at=now)
        kill(booking)
        stats = reconcile.run(now=now)
        refund = Refund.objects.get()
        payment.refresh_from_db()
        assert stats["auto_refunds"] == 1
        assert refund.reason == RefundReason.UNPAID_BOOKING
        assert refund.idempotency_key == f"auto:{payment.pk}"
        assert payment.refunded_amount == payment.amount

    def test_running_twice_creates_one_refund(self, booking, now, queued):
        make_payment(booking, status=PaymentStatus.PAID, performed_at=now)
        kill(booking, S.CANCELLED)
        reconcile.run(now=now)
        reconcile.run(now=now)
        assert Refund.objects.count() == 1

    def test_a_payment_that_confirmed_its_cancelled_booking_is_not_auto_refunded(
        self, booking, now, queued
    ):
        make_payment(booking, status=PaymentStatus.PAID, performed_at=now)
        kill(booking, S.CANCELLED, paid_amount=booking.amount, refund_amount=0)
        reconcile.run(now=now)
        assert not Refund.objects.exists()


class TestRefundRequeue:
    def test_lost_pending_refunds_are_enqueued(self, booking, now, queued):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        refund = make_refund(payment)
        Refund.objects.filter(pk=refund.pk).update(updated_at=now - timedelta(hours=1))
        stats = reconcile.run(now=now)
        assert queued == [str(refund.pk)]
        assert stats["refunds_requeued"] == 1

    def test_recent_refunds_are_left_to_their_own_task(self, booking, now, queued):
        make_refund(make_payment(booking, status=PaymentStatus.PAID))
        reconcile.run(now=now)
        assert queued == []

    def test_a_refund_waiting_out_its_backoff_is_not_enqueued(self, booking, now, queued):
        refund = make_refund(make_payment(booking, status=PaymentStatus.PAID))
        Refund.objects.filter(pk=refund.pk).update(
            updated_at=now - timedelta(hours=1), next_attempt_at=now + timedelta(minutes=20)
        )
        reconcile.run(now=now)
        assert queued == []

    def test_a_stale_claim_of_a_dead_worker_is_enqueued(self, booking, now, queued):
        refund = make_refund(make_payment(booking, status=PaymentStatus.PAID))
        Refund.objects.filter(pk=refund.pk).update(
            status=RefundStatus.SENT, next_attempt_at=now - timedelta(minutes=1)
        )
        reconcile.run(now=now)
        assert queued == [str(refund.pk)]

    def test_finished_refunds_are_never_enqueued(self, booking, now, queued):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        for status in (RefundStatus.DONE, RefundStatus.MANUAL, RefundStatus.FAILED):
            refund = make_refund(payment, status=status, amount="1")
            Refund.objects.filter(pk=refund.pk).update(updated_at=now - timedelta(days=1))
        reconcile.run(now=now)
        assert queued == []


class TestIsolationAndLimits:
    def test_one_poisoned_item_does_not_stop_the_rest(self, booking, make_pending, now, caplog):
        other = make_pending()
        first = make_payment(booking, provider="click", external_id="1")
        second = make_payment(other, provider="click", external_id="2")
        for payment in (first, second):
            age(Payment, payment.pk, 60)
        kill(booking)
        kill(other)
        real = reconcile._cancel_orphan
        calls = []

        def flaky(payment_id, now):
            calls.append(payment_id)
            if len(calls) == 1:
                raise RuntimeError("secret detail")
            return real(payment_id, now)

        with mock.patch.object(reconcile, "_cancel_orphan", side_effect=flaky):
            stats = reconcile.run(now=now)
        assert stats["errors"] == 1
        assert stats["orphans_cancelled"] == 1
        assert "secret detail" not in caplog.text  # only ids and exception types are logged

    @override_settings(PAYMENTS_TASK_BATCH_LIMIT=1)
    def test_batch_limit(self, booking, make_pending, now):
        other = make_pending()
        for b, ext in ((booking, "1"), (other, "2")):
            payment = make_payment(b, provider="click", external_id=ext)
            age(Payment, payment.pk, 60)
            kill(b)
        stats = reconcile.run(now=now)
        assert stats["orphans_cancelled"] == 1
        reconcile.run(now=now)
        assert not Payment.objects.filter(status=PaymentStatus.PENDING).exists()


def test_task_returns_the_stats():
    assert tasks.retry_failed_webhooks.run()["errors"] == 0


def test_beat_runs_it_every_five_minutes():
    from config.celery import CELERY_BEAT_SCHEDULE

    entry = CELERY_BEAT_SCHEDULE["payments-retry-failed-webhooks"]
    assert entry["task"] == "payments.retry_failed_webhooks"
    assert entry["schedule"] == 300.0 and entry["options"] == {"expires": 300}


class TestRepairSelection:
    def test_partially_refunded_payments_do_not_crowd_out_the_real_candidate(
        self, booking, make_pending, now
    ):
        from apps.payments import selectors

        for i in range(8):  # DONE refund of 100 of 12 000: not finished, must not be selected
            payment = make_payment(
                make_pending(), status=PaymentStatus.PAID, external_id=f"p{i}", provider="click"
            )
            make_refund(payment, amount="100", status=RefundStatus.DONE, key=f"partial{i}")
        target = make_payment(booking, status=PaymentStatus.PAID)
        make_refund(target, status=RefundStatus.DONE, key="full")  # covers the whole payment
        assert selectors.payments_with_done_refunds(limit=3) == [target.pk]

    def test_the_sweep_does_not_touch_partial_ones(self, booking, now):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        make_refund(payment, amount="100", status=RefundStatus.DONE)
        assert reconcile.run(now=now)["payments_repaired"] == 0
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.PAID


class TestAlertNoise:
    def test_the_same_unresolved_refund_is_announced_once_a_day(self, booking, now, caplog):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        refund = make_refund(payment, status=RefundStatus.MANUAL)
        Refund.objects.filter(pk=refund.pk).update(updated_at=now - timedelta(days=2))
        for _ in range(3):
            stats = reconcile.run(now=now)
            assert stats["manual_refunds"] == 1  # still counted every run
        errors = [r for r in caplog.records if "refunds MANUAL" in r.getMessage()]
        assert len(errors) == 1

    def test_a_new_refund_is_announced_at_once(self, booking, make_pending, now, caplog):
        for target in (booking, make_pending()):
            refund = make_refund(
                make_payment(target, status=PaymentStatus.PAID),
                status=RefundStatus.MANUAL,
                key=f"k{target.pk}",
            )
            Refund.objects.filter(pk=refund.pk).update(updated_at=now - timedelta(days=2))
            reconcile.run(now=now)
        assert len([r for r in caplog.records if "refunds MANUAL" in r.getMessage()]) == 2
