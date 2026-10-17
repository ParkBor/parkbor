"""The operator path for MANUAL / FAILED refunds (Step 11's admin UI calls the same service)."""

import logging
import uuid
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import CommandError, call_command

from apps.bookings.models import BookingEvent
from apps.core.exceptions import InvalidTransition, NotFoundError
from apps.payments import refunds, tasks
from apps.payments.models import Payment, PaymentStatus, Refund, RefundStatus
from tests.helpers import make_user
from tests.payments.factories import make_payment, make_refund

pytestmark = pytest.mark.django_db


@pytest.fixture
def queued(monkeypatch):
    calls = []
    monkeypatch.setattr(tasks.send_refund, "apply_async", lambda *a, **k: calls.append(a[0][0]))
    return calls


def resolve(refund_id, outcome, **kw):
    """The service with a valid operator (an ADMIN user) unless a test says otherwise."""
    kw.setdefault("actor", make_user("ADMIN"))
    return refunds.resolve_manual_refund(refund_id, outcome, **kw)


def manual(booking, status=RefundStatus.MANUAL, amount="12000", **extra):
    payment = make_payment(booking, status=PaymentStatus.PAID, refunded_amount=amount)
    return payment, make_refund(payment, amount=amount, status=status, **extra)


class TestDone:
    def test_a_manual_refund_done_by_hand_closes_the_payment(self, booking, now):
        payment, refund = manual(booking)
        resolve(refund.pk, "done", note="refunded in Payme cabinet", now=now)
        refund.refresh_from_db()
        payment.refresh_from_db()
        assert refund.status == RefundStatus.DONE and refund.done_at == now
        assert payment.status == PaymentStatus.REFUNDED
        event = BookingEvent.objects.get(booking=booking, reason="refund_resolved")
        assert event.meta["outcome"] == "done" and event.meta["note"].startswith("refunded")

    def test_a_failed_refund_checked_in_the_cabinet_can_be_marked_done(self, booking, now):
        _, refund = manual(booking, status=RefundStatus.FAILED, last_error="click_error_-5")
        resolve(refund.pk, "done", now=now)
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE and refund.last_error == ""

    def test_a_partial_done_leaves_the_payment_paid(self, booking, now):
        payment, refund = manual(booking, amount="6000")
        resolve(refund.pk, "done", now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.PAID

    def test_a_refund_without_a_payment_can_be_done(self, booking, now):
        refund = make_refund(make_payment(booking, status=PaymentStatus.PAID), status="MANUAL")
        Refund.objects.filter(pk=refund.pk).update(payment=None)
        resolve(refund.pk, "done", now=now)
        assert Refund.objects.get(pk=refund.pk).status == RefundStatus.DONE

    def test_the_resolution_is_audited(
        self, booking, now, caplog, django_capture_on_commit_callbacks
    ):
        _, refund = manual(booking)
        with caplog.at_level(logging.INFO, logger="habi.audit"):
            with django_capture_on_commit_callbacks(execute=True):
                resolve(refund.pk, "done", note="x", now=now)
        record = next(
            r for r in caplog.records if getattr(r, "audit_action", "") == "refund.resolve"
        )
        assert record.audit_before["status"] == "MANUAL"
        assert record.audit_after["status"] == "DONE"


class TestRetry:
    def test_a_failed_refund_goes_back_to_the_queue_from_scratch(
        self, booking, now, queued, django_capture_on_commit_callbacks
    ):
        payment, refund = manual(booking, status=RefundStatus.FAILED, last_error="timeout")
        Refund.objects.filter(pk=refund.pk).update(attempts=8)
        with django_capture_on_commit_callbacks(execute=True):
            resolve(refund.pk, "retry", now=now)
        refund.refresh_from_db()
        payment.refresh_from_db()
        assert (refund.status, refund.attempts, refund.last_error) == ("PENDING", 0, "")
        assert refund.next_attempt_at is None
        assert payment.refunded_amount == Decimal("12000")  # the reservation stays
        assert queued == [str(refund.pk)]

    def test_a_manual_refund_cannot_be_retried_there_is_no_api(self, booking, now, queued):
        _, refund = manual(booking)
        with pytest.raises(InvalidTransition):
            resolve(refund.pk, "retry", now=now)
        assert Refund.objects.get(pk=refund.pk).status == RefundStatus.MANUAL


class TestFailed:
    def test_giving_up_releases_the_reservation(self, booking, now):
        payment, refund = manual(booking)
        resolve(refund.pk, "failed", note="customer refused", now=now)
        refund.refresh_from_db()
        payment.refresh_from_db()
        assert refund.status == RefundStatus.FAILED and refund.last_error == "operator_failed"
        assert payment.refunded_amount == 0 and payment.status == PaymentStatus.PAID

    def test_only_a_manual_refund_can_be_given_up(self, booking, now):
        _, refund = manual(booking, status=RefundStatus.FAILED)
        with pytest.raises(InvalidTransition):
            resolve(refund.pk, "failed", now=now)


class TestGuards:
    @pytest.mark.parametrize("status", ["PENDING", "SENT", "DONE"])
    def test_refunds_in_flight_or_finished_are_not_touched(self, booking, now, status):
        _, refund = manual(booking, status=status)
        for outcome in ("done", "retry", "failed"):
            with pytest.raises(InvalidTransition):
                resolve(refund.pk, outcome, now=now)
        assert Refund.objects.get(pk=refund.pk).status == status

    def test_unknown_refund(self, now):
        with pytest.raises(NotFoundError):
            resolve(uuid.uuid4(), "done", now=now)

    def test_unknown_outcome(self, booking, now):
        _, refund = manual(booking)
        with pytest.raises(ValueError):
            resolve(refund.pk, "maybe", now=now)

    def test_a_long_note_is_cut(self, booking, now):
        _, refund = manual(booking)
        resolve(refund.pk, "done", note="x" * 1000, now=now)
        event = BookingEvent.objects.get(booking=booking, reason="refund_resolved")
        assert len(event.meta["note"]) == 200


class TestCommand:
    def run(self, *args):
        out = StringIO()
        if "--actor" not in args:
            args = (*args, "--actor", str(make_user("ADMIN").telegram_id))
        call_command("resolve_refund", *args, stdout=out)
        return out.getvalue()

    def test_done(self, booking):
        payment, refund = manual(booking)
        assert "DONE" in self.run(str(refund.pk), "--done", "--note", "cabinet")
        assert Refund.objects.get(pk=refund.pk).status == RefundStatus.DONE
        assert Payment.objects.get(pk=payment.pk).status == PaymentStatus.REFUNDED

    def test_retry(self, booking, queued):
        _, refund = manual(booking, status=RefundStatus.FAILED)
        assert "PENDING" in self.run(str(refund.pk), "--retry")

    def test_failed(self, booking):
        _, refund = manual(booking)
        self.run(str(refund.pk), "--failed", "--note", "no")
        assert Refund.objects.get(pk=refund.pk).status == RefundStatus.FAILED

    def test_exactly_one_outcome_is_required(self, booking):
        _, refund = manual(booking)
        with pytest.raises(CommandError):
            self.run(str(refund.pk))
        with pytest.raises(CommandError):
            self.run(str(refund.pk), "--done", "--retry")

    def test_bad_input_is_a_clean_error(self, booking):
        with pytest.raises(CommandError):
            self.run("not-a-uuid", "--done")
        with pytest.raises(CommandError):
            self.run(str(uuid.uuid4()), "--done")
        _, refund = manual(booking, status=RefundStatus.PENDING)
        with pytest.raises(CommandError):
            self.run(str(refund.pk), "--done")
