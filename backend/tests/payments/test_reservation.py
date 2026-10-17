"""The reservation invariant, operator identity and notes, several PAID payments, and the lint's
extra patterns. Invariant: for every Payment,
    sum(Refund.amount of refunds that hold money back) == Payment.refunded_amount
where a refund holds money back unless it is FAILED *by an operator* ("operator_failed")."""

import logging
from datetime import timedelta
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import CommandError, call_command

from apps.bookings import hooks
from apps.bookings import services as booking_services
from apps.bookings.models import Booking, BookingEvent
from apps.core.exceptions import ApiError, InvalidTransition
from apps.payments import reconcile, refunds, tasks
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
    kw.setdefault("actor", make_user("ADMIN"))
    return refunds.resolve_manual_refund(refund_id, outcome, **kw)


def manual(booking, status=RefundStatus.MANUAL, amount="12000", **extra):
    payment = make_payment(booking, status=PaymentStatus.PAID, refunded_amount=amount)
    return payment, make_refund(payment, amount=amount, status=status, **extra)


def reserved(payment):
    payment.refresh_from_db()
    return refunds.reserved_total(payment), payment.refunded_amount


class TestReservationInvariant:
    def test_the_chain_failed_then_anything_cannot_over_refund(self, booking, now):
        payment, refund = manual(booking)
        resolve(refund.pk, "failed", now=now)
        assert reserved(payment) == (0, 0)
        for outcome in ("retry", "done", "failed"):  # an operator-failed refund is final
            with pytest.raises(InvalidTransition):
                resolve(refund.pk, outcome, now=now)
        assert reserved(payment) == (0, 0)

    def test_after_giving_up_the_money_can_be_refunded_once_more_but_not_twice(self, booking, now):
        payment, refund = manual(booking)
        resolve(refund.pk, "failed", now=now)
        payment.refresh_from_db()
        again = refunds.create_auto_refund(payment, "unpaid_booking", now=now)
        assert again.amount == payment.amount
        assert reserved(payment) == (payment.amount, payment.amount)
        assert refunds.create_auto_refund(payment, "unpaid_booking", now=now).pk == again.pk
        assert reserved(payment) == (payment.amount, payment.amount)

    def test_an_automatic_failure_keeps_its_reservation_and_may_be_retried(
        self, booking, now, queued
    ):
        payment, refund = manual(booking, status=RefundStatus.FAILED, last_error="click_error_-5")
        assert reserved(payment) == (payment.amount, payment.amount)
        resolve(refund.pk, "retry", now=now)
        assert reserved(payment) == (payment.amount, payment.amount)

    def test_done_keeps_the_reservation(self, booking, now):
        payment, refund = manual(booking)
        resolve(refund.pk, "done", now=now)
        assert reserved(payment) == (payment.amount, payment.amount)

    def test_a_corrupted_reservation_stops_the_operator_and_writes_nothing(self, booking, now):
        payment, refund = manual(booking)
        Payment.objects.filter(pk=payment.pk).update(refunded_amount=Decimal("5"))
        with pytest.raises(ApiError) as caught:
            resolve(refund.pk, "done", now=now)
        assert str(caught.value.detail["code"]) == "reservation_mismatch"

    def test_settling_by_the_provider_covers_automatic_failures_too(self, booking, now):
        payment, refund = manual(booking, status=RefundStatus.FAILED, last_error="click_error_-5")
        refunds.settle_by_provider(payment, booking, now=now)
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE
        assert Refund.objects.filter(payment=payment).count() == 1  # nothing added on top

    def test_settling_ignores_what_the_operator_gave_up(self, booking, now):
        payment, refund = manual(booking)
        resolve(refund.pk, "failed", now=now)
        payment.refresh_from_db()
        refunds.settle_by_provider(payment, booking, now=now)
        assert Refund.objects.get(pk=refund.pk).status == RefundStatus.FAILED
        rest = Refund.objects.get(idempotency_key=f"provider:{payment.pk}")
        assert rest.amount == payment.amount and rest.status == RefundStatus.DONE


class TestSweepChecksTheInvariant:
    def old(self, refund, now):
        Refund.objects.filter(pk=refund.pk).update(updated_at=now - timedelta(minutes=1))

    def test_consistent_payments_are_quiet(self, booking, now):
        _, refund = manual(booking)
        self.old(refund, now)
        assert reconcile.run(now=now)["reservation_mismatch"] == 0

    def test_a_mismatch_is_counted_and_logged(self, booking, now, caplog):
        payment, refund = manual(booking)
        Payment.objects.filter(pk=payment.pk).update(refunded_amount=Decimal("1"))
        self.old(refund, now)
        stats = reconcile.run(now=now)
        assert stats["reservation_mismatch"] == 1
        assert any(
            r.levelname == "ERROR" and str(payment.pk) in r.getMessage() for r in caplog.records
        )

    def test_operator_failed_refunds_do_not_count_but_automatic_ones_do(self, booking, now):
        payment, refund = manual(booking, status=RefundStatus.FAILED, last_error="click_error_-5")
        self.old(refund, now)
        assert reconcile.run(now=now)["reservation_mismatch"] == 0
        Refund.objects.filter(pk=refund.pk).update(last_error="operator_failed")
        assert reconcile.run(now=now)["reservation_mismatch"] == 1  # reservation now too high

    def test_old_untouched_payments_are_not_scanned(self, booking, now):
        payment, refund = manual(booking)
        Payment.objects.filter(pk=payment.pk).update(refunded_amount=Decimal("1"))
        Refund.objects.filter(pk=refund.pk).update(updated_at=now - timedelta(days=30))
        assert reconcile.run(now=now)["reservation_mismatch"] == 0


class TestOperatorIdentity:
    def test_an_operator_is_required(self, booking, now):
        _, refund = manual(booking)
        with pytest.raises(ValueError):
            refunds.resolve_manual_refund(refund.pk, "done", actor=None, now=now)

    def test_the_operator_is_in_the_audit_record_and_the_history(
        self, booking, now, caplog, django_capture_on_commit_callbacks
    ):
        _, refund = manual(booking)
        admin = make_user("ADMIN")
        with caplog.at_level(logging.INFO, logger="habi.audit"):
            with django_capture_on_commit_callbacks(execute=True):
                refunds.resolve_manual_refund(refund.pk, "done", actor=admin, now=now)
        record = next(
            r for r in caplog.records if getattr(r, "audit_action", "") == "refund.resolve"
        )
        assert record.audit_actor == str(admin.pk)
        event = BookingEvent.objects.get(booking=booking, reason="refund_resolved")
        assert event.meta["actor"] == str(admin.pk)


class TestNotes:
    @pytest.mark.parametrize(
        "note",
        ["call +998901234567", "card 8600 1234 5678 9012", "tel 998-90-123-45-67", "123456789"],
    )
    def test_phone_and_card_like_values_are_rejected(self, booking, now, note):
        _, refund = manual(booking)
        with pytest.raises(ValueError):
            resolve(refund.pk, "done", note=note, now=now)
        assert Refund.objects.get(pk=refund.pk).status == RefundStatus.MANUAL

    @pytest.mark.parametrize("note", ["refunded in cabinet, ticket 4521", "order 12345678", ""])
    def test_ordinary_notes_pass(self, booking, now, note):
        _, refund = manual(booking)
        resolve(refund.pk, "done", note=note, now=now)


class TestCommandIdentity:
    def run(self, *args):
        call_command("resolve_refund", *args, stdout=StringIO())

    def test_actor_is_required(self, booking):
        _, refund = manual(booking)
        with pytest.raises(CommandError):
            self.run(str(refund.pk), "--done")

    @pytest.mark.parametrize("kind", ["telegram_id", "uuid", "username"])
    def test_actor_may_be_named_three_ways(self, booking, kind):
        admin = make_user("ADMIN", telegram_username="ops_anna")
        value = {
            "telegram_id": str(admin.telegram_id),
            "uuid": str(admin.pk),
            "username": "@ops_anna",
        }[kind]
        _, refund = manual(booking)
        self.run(str(refund.pk), "--done", "--actor", value)
        assert Refund.objects.get(pk=refund.pk).status == RefundStatus.DONE

    @pytest.mark.parametrize("who", ["999999999", "@nobody", "not-a-uuid-or-number"])
    def test_unknown_actor(self, booking, who):
        _, refund = manual(booking)
        with pytest.raises(CommandError):
            self.run(str(refund.pk), "--done", "--actor", who)
        assert Refund.objects.get(pk=refund.pk).status == RefundStatus.MANUAL

    def test_only_active_admins_may_resolve(self, booking):
        _, refund = manual(booking)
        for user in (make_user("DRIVER"), make_user("ADMIN", is_active=False)):
            with pytest.raises(CommandError):
                self.run(str(refund.pk), "--done", "--actor", str(user.telegram_id))

    def test_a_note_with_a_phone_number_is_a_clean_error(self, booking):
        admin = make_user("ADMIN")
        _, refund = manual(booking)
        with pytest.raises(CommandError):
            self.run(
                str(refund.pk),
                "--done",
                "--actor",
                str(admin.telegram_id),
                "--note",
                "+998901234567",
            )


class TestSeveralPaidPayments:
    def two(self, booking, now, first="8000", second="4000"):
        a = make_payment(booking, status=PaymentStatus.PAID, amount=first, performed_at=now)
        b = make_payment(
            booking,
            status=PaymentStatus.PAID,
            amount=second,
            performed_at=now + timedelta(seconds=1),
        )
        return a, b

    def test_the_rest_is_taken_from_the_next_paid_payment(
        self, booking, now, queued, django_capture_on_commit_callbacks
    ):
        first, second = self.two(booking, now)
        with django_capture_on_commit_callbacks(execute=True):
            refund = refunds.create_booking_refund(booking, Decimal("12000"))
        rows = list(Refund.objects.order_by("created_at"))
        assert len(rows) == 2 and all(r.status == RefundStatus.PENDING for r in rows)
        assert {(r.payment_id, r.amount) for r in rows} == {
            (first.pk, Decimal("8000")),
            (second.pk, Decimal("4000")),
        }
        assert refund.payment_id == first.pk
        assert {r.idempotency_key for r in rows} == {
            f"cancel:{booking.pk}",
            f"cancel:{booking.pk}:2",
        }
        assert len(queued) == 2
        assert reserved(first) == (Decimal("8000"), Decimal("8000"))
        assert reserved(second) == (Decimal("4000"), Decimal("4000"))

    def test_only_what_no_payment_holds_becomes_a_manual_shortfall(self, booking, now, queued):
        self.two(booking, now, first="8000", second="2000")
        refunds.create_booking_refund(booking, Decimal("12000"))
        shortfall = Refund.objects.get(idempotency_key=f"cancel:{booking.pk}:shortfall")
        assert shortfall.amount == Decimal("2000") and shortfall.status == RefundStatus.MANUAL

    def test_a_repeat_creates_nothing_more(self, booking, now, queued):
        self.two(booking, now)
        refunds.create_booking_refund(booking, Decimal("12000"))
        refunds.create_booking_refund(booking, Decimal("12000"))
        assert Refund.objects.count() == 2


class TestHandlerMissingOutsideTheWebProcess:
    """`hooks._refund_handler` is set by PaymentsConfig.ready(). A context where ready() did not
    run must refuse to cancel a paid booking, not drop the refund."""

    def test_after_a_management_command_a_missing_handler_is_still_refused(
        self, booking, now, monkeypatch
    ):
        from apps.payments import services

        payment = services.register_transaction(
            booking_id=booking.pk,
            provider="payme",
            external_id="m" * 24,
            amount=booking.amount,
            now=now,
        ).payment
        services.complete_payment(provider="payme", external_id=payment.external_id, now=now)
        call_command("check", stdout=StringIO())  # a command ran; ready() had completed already
        monkeypatch.setattr(hooks, "_refund_handler", None)  # a process where ready() did not
        with pytest.raises(ApiError) as caught:
            booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        assert str(caught.value.detail["code"]) == "refund_handler_missing"
        assert Booking.objects.get(pk=booking.pk).status == "CONFIRMED"
        assert not Refund.objects.exists()
