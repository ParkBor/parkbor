"""Payment lifecycle on top of the booking state machine (SQLite logic tests; the lock and
race behaviour on real PostgreSQL is in test_postgis.py)."""

from datetime import timedelta
from decimal import Decimal
from unittest import mock

import pytest

from apps.bookings import services as booking_services
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.bookings.state import status_write_allowed
from apps.payments import errors, services
from apps.payments.models import Payment, PaymentStatus, Refund, RefundReason, RefundStatus
from tests.payments.factories import make_payment, make_refund, payme_id

pytestmark = pytest.mark.django_db

AMOUNT = Decimal("12000.00")


def register(booking, now, **kw):
    kw.setdefault("provider", "payme")
    kw.setdefault("external_id", payme_id())
    kw.setdefault("amount", AMOUNT)
    return services.register_transaction(booking_id=booking.pk, now=now, **kw)


def force_status(booking, status, **fields):
    with status_write_allowed():
        Booking.objects.filter(pk=booking.pk).update(status=status, **fields)
    booking.refresh_from_db()


class TestCheckOrder:
    def test_payable_order_passes(self, booking, now):
        assert services.check_order(booking.pk, AMOUNT, now=now).pk == booking.pk

    def test_unknown_order(self, now):
        import uuid

        with pytest.raises(errors.OrderNotFound):
            services.check_order(uuid.uuid4(), AMOUNT, now=now)

    def test_wrong_amount(self, booking, now):
        with pytest.raises(errors.AmountMismatch):
            services.check_order(booking.pk, Decimal("11999.99"), now=now)

    @pytest.mark.parametrize("status", [S.CANCELLED, S.EXPIRED])
    def test_dead_booking_is_not_payable(self, booking, now, status):
        force_status(booking, status)
        with pytest.raises(errors.OrderNotPayable):
            services.check_order(booking.pk, AMOUNT, now=now)

    @pytest.mark.parametrize("status", [S.CONFIRMED, S.ACTIVE, S.COMPLETED])
    def test_paid_booking_is_reported_as_paid(self, booking, now, status):
        force_status(booking, status)
        with pytest.raises(errors.OrderAlreadyPaid):
            services.check_order(booking.pk, AMOUNT, now=now)

    def test_hold_that_ran_out_is_not_payable(self, booking, now):
        with pytest.raises(errors.OrderNotPayable):
            services.check_order(booking.pk, AMOUNT, now=now + timedelta(minutes=11))


class TestRegisterTransaction:
    def test_creates_a_pending_payment(self, booking, now):
        result = register(booking, now, provider_time=1_700_000_000_000)
        payment = result.payment
        assert result.created is True
        assert payment.status == PaymentStatus.PENDING
        assert payment.booking_id == booking.pk
        assert payment.amount == AMOUNT
        assert payment.provider_time == 1_700_000_000_000
        assert Payment.objects.count() == 1

    def test_repeat_with_the_same_id_is_idempotent(self, booking, now):
        first = register(booking, now, external_id="a" * 24)
        again = register(booking, now, external_id="a" * 24)
        assert again.created is False
        assert again.payment.pk == first.payment.pk
        assert Payment.objects.count() == 1

    def test_repeat_with_another_amount_is_refused(self, booking, now):
        register(booking, now, external_id="a" * 24)
        with pytest.raises(errors.AmountMismatch):
            register(booking, now, external_id="a" * 24, amount=Decimal("1.00"))

    def test_wrong_amount_creates_nothing(self, booking, now):
        with pytest.raises(errors.AmountMismatch):
            register(booking, now, amount=Decimal("100.00"))
        assert not Payment.objects.exists()

    def test_unknown_booking(self, now):
        import uuid

        with pytest.raises(errors.OrderNotFound):
            services.register_transaction(
                booking_id=uuid.uuid4(),
                provider="payme",
                external_id=payme_id(),
                amount=AMOUNT,
                now=now,
            )

    @pytest.mark.parametrize("status", [S.CANCELLED, S.EXPIRED])
    def test_dead_booking(self, booking, now, status):
        force_status(booking, status)
        with pytest.raises(errors.OrderNotPayable):
            register(booking, now)

    def test_paid_booking(self, booking, now):
        force_status(booking, S.CONFIRMED, paid_amount=AMOUNT)
        with pytest.raises(errors.OrderAlreadyPaid):
            register(booking, now)

    def test_second_open_transaction_for_the_same_booking_conflicts(self, booking, now):
        register(booking, now)
        with pytest.raises(errors.ConflictingTransaction):
            register(booking, now)
        assert Payment.objects.count() == 1

    def test_supersede_cancels_the_older_open_transaction(self, booking, now):
        old = register(booking, now, provider="click", external_id="11").payment
        new = register(booking, now, provider="click", external_id="12", supersede=True).payment
        old.refresh_from_db()
        assert old.status == PaymentStatus.CANCELLED
        assert new.status == PaymentStatus.PENDING

    def test_open_transactions_of_different_providers_coexist(self, booking, now):
        register(booking, now, provider="payme")
        register(booking, now, provider="click", external_id="77")
        assert Payment.objects.filter(status=PaymentStatus.PENDING).count() == 2

    def test_provider_transaction_id_cannot_serve_two_bookings(self, booking, make_pending, now):
        other = make_pending()
        register(booking, now, external_id="b" * 24)
        with pytest.raises(errors.ConflictingTransaction):
            register(other, now, external_id="b" * 24)

    def test_provider_ref_is_stored(self, booking, now):
        payment = register(
            booking, now, provider="click", external_id="5", provider_ref="9"
        ).payment
        assert payment.provider_ref == "9"

    def test_history_records_the_start_of_payment(self, booking, now):
        register(booking, now)
        assert BookingEvent.objects.filter(booking=booking, reason="payment_pending").count() == 1


class TestHoldGrace:
    def test_hold_is_stretched_when_a_transaction_starts_near_its_end(self, booking, now):
        late = now + timedelta(minutes=9)
        register(booking, late)
        booking.refresh_from_db()
        assert booking.hold_expires_at == late + timedelta(minutes=5)
        assert BookingEvent.objects.filter(booking=booking, reason="hold_extended").exists()

    def test_hold_is_never_shortened(self, booking, now):
        register(booking, now)  # now + 5 min < current hold (now + 10 min)
        booking.refresh_from_db()
        assert booking.hold_expires_at == now + timedelta(minutes=10)

    def test_repeated_payment_attempts_cannot_stretch_the_hold_past_the_ceiling(self, booking, now):
        ceiling = booking.created_at + timedelta(minutes=10) + timedelta(minutes=5)
        first = register(booking, now + timedelta(minutes=9)).payment
        services.cancel_transaction(
            provider="payme", external_id=first.external_id, now=now + timedelta(minutes=9)
        )
        register(booking, now + timedelta(minutes=13))  # would be now + 18 min uncapped
        booking.refresh_from_db()
        assert booking.hold_expires_at == ceiling

    def test_a_dead_booking_is_not_extended(self, booking, now):
        force_status(booking, S.EXPIRED)
        before = booking.hold_expires_at
        with pytest.raises(errors.OrderNotPayable):
            register(booking, now)
        booking.refresh_from_db()
        assert booking.hold_expires_at == before


class TestCompletePayment:
    def make(self, booking, now):
        return register(booking, now).payment

    def test_confirms_the_booking_and_marks_the_payment_paid(self, booking, now):
        payment = self.make(booking, now)
        result = services.complete_payment(
            provider="payme", external_id=payment.external_id, now=now
        )
        booking.refresh_from_db()
        payment.refresh_from_db()
        assert result.outcome is services.CompleteOutcome.PAID
        assert booking.status == S.CONFIRMED
        assert booking.paid_amount == AMOUNT
        assert payment.status == PaymentStatus.PAID
        assert payment.performed_at == now

    def test_repeat_is_idempotent(self, booking, now):
        payment = self.make(booking, now)
        services.complete_payment(provider="payme", external_id=payment.external_id, now=now)
        later = now + timedelta(seconds=30)
        again = services.complete_payment(
            provider="payme", external_id=payment.external_id, now=later
        )
        payment.refresh_from_db()
        assert again.outcome is services.CompleteOutcome.ALREADY_PAID
        assert payment.performed_at == now  # not rewritten
        assert BookingEvent.objects.filter(booking=booking, reason="payment_confirmed").count() == 1

    def test_unknown_transaction(self, now):
        with pytest.raises(errors.TransactionNotFound):
            services.complete_payment(provider="payme", external_id=payme_id(), now=now)

    def test_cancelled_transaction_cannot_be_performed(self, booking, now):
        payment = make_payment(booking, status=PaymentStatus.CANCELLED)
        with pytest.raises(errors.TransactionStateError):
            services.complete_payment(provider="payme", external_id=payment.external_id, now=now)

    def test_expired_booking_refuses_the_payment_and_changes_nothing(self, booking, now):
        payment = self.make(booking, now)
        booking_services.expire_hold(booking.pk, now=now + timedelta(minutes=20))
        with pytest.raises(errors.OrderNotPayable):
            services.complete_payment(
                provider="payme", external_id=payment.external_id, now=now + timedelta(minutes=21)
            )
        booking.refresh_from_db()
        payment.refresh_from_db()
        assert booking.status == S.EXPIRED
        assert booking.paid_amount == 0
        assert payment.status == PaymentStatus.PENDING
        assert not Refund.objects.exists()

    def test_hold_that_ran_out_but_was_not_swept_is_still_accepted(self, booking, now):
        """The slot is still this booking's and the money is on its way: take it."""
        payment = self.make(booking, now)
        late = now + timedelta(minutes=12)
        result = services.complete_payment(
            provider="payme", external_id=payment.external_id, now=late
        )
        booking.refresh_from_db()
        assert result.outcome is services.CompleteOutcome.PAID
        assert booking.status == S.CONFIRMED

    def test_money_for_a_dead_booking_is_accepted_and_refunded_when_asked(self, booking, now):
        payment = self.make(booking, now)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        result = services.complete_payment(
            provider="payme", external_id=payment.external_id, now=now, accept_unpayable=True
        )
        booking.refresh_from_db()
        payment.refresh_from_db()
        refund = Refund.objects.get()
        assert result.outcome is services.CompleteOutcome.PAID_AND_REFUNDING
        assert payment.status == PaymentStatus.PAID
        assert booking.status == S.CANCELLED and booking.paid_amount == 0
        assert refund.amount == AMOUNT
        assert refund.status == RefundStatus.PENDING
        assert refund.reason == RefundReason.UNPAID_BOOKING
        assert refund.idempotency_key == f"auto:{payment.pk}"
        assert payment.refunded_amount == AMOUNT

    def test_second_payment_for_a_paid_booking_is_refunded_as_a_duplicate(self, booking, now):
        first = register(booking, now, provider="payme").payment
        second = register(booking, now, provider="click", external_id="99").payment
        services.complete_payment(provider="payme", external_id=first.external_id, now=now)
        result = services.complete_payment(
            provider="click", external_id="99", now=now, accept_unpayable=True
        )
        booking.refresh_from_db()
        assert result.outcome is services.CompleteOutcome.PAID_AND_REFUNDING
        assert booking.status == S.CONFIRMED and booking.paid_amount == AMOUNT
        refund = Refund.objects.get(payment=second)
        assert refund.reason == RefundReason.DUPLICATE

    def test_auto_refund_is_created_only_once(self, booking, now):
        payment = self.make(booking, now)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        for _ in range(3):
            services.complete_payment(
                provider="payme", external_id=payment.external_id, now=now, accept_unpayable=True
            )
        assert Refund.objects.count() == 1

    def test_a_failure_while_confirming_leaves_everything_untouched(self, booking, now):
        payment = self.make(booking, now)
        with (
            mock.patch.object(booking_services, "confirm_locked", side_effect=RuntimeError("x")),
            pytest.raises(RuntimeError),
        ):
            services.complete_payment(provider="payme", external_id=payment.external_id, now=now)
        booking.refresh_from_db()
        payment.refresh_from_db()
        assert booking.status == S.PENDING_PAYMENT
        assert payment.status == PaymentStatus.PENDING
        assert payment.performed_at is None

    def test_expire_sweep_after_payment_does_not_undo_it(self, booking, now):
        payment = self.make(booking, now)
        services.complete_payment(provider="payme", external_id=payment.external_id, now=now)
        assert booking_services.expire_hold(booking.pk, now=now + timedelta(hours=1)) is False
        booking.refresh_from_db()
        assert booking.status == S.CONFIRMED

    def test_payment_after_the_sweep_expired_the_booking_is_refused(self, booking, now):
        payment = self.make(booking, now)
        assert booking_services.expire_hold(booking.pk, now=now + timedelta(hours=1)) is True
        with pytest.raises(errors.OrderNotPayable):
            services.complete_payment(
                provider="payme", external_id=payment.external_id, now=now + timedelta(hours=1)
            )


class TestCancelTransaction:
    def test_cancelling_a_pending_transaction(self, booking, now):
        payment = register(booking, now).payment
        result = services.cancel_transaction(
            provider="payme", external_id=payment.external_id, now=now, raw={"reason": 3}
        )
        payment.refresh_from_db()
        booking.refresh_from_db()
        assert result.was_performed is False
        assert payment.status == PaymentStatus.CANCELLED
        assert payment.cancelled_at == now
        assert payment.raw_state == {"reason": 3}
        assert booking.status == S.PENDING_PAYMENT  # the driver may pay again

    def test_cancel_is_idempotent(self, booking, now):
        payment = register(booking, now).payment
        services.cancel_transaction(provider="payme", external_id=payment.external_id, now=now)
        later = now + timedelta(minutes=1)
        services.cancel_transaction(provider="payme", external_id=payment.external_id, now=later)
        payment.refresh_from_db()
        assert payment.cancelled_at == now

    def test_unknown_transaction(self, now):
        with pytest.raises(errors.TransactionNotFound):
            services.cancel_transaction(provider="payme", external_id=payme_id(), now=now)

    def test_a_new_transaction_is_allowed_after_a_cancel(self, booking, now):
        first = register(booking, now).payment
        services.cancel_transaction(provider="payme", external_id=first.external_id, now=now)
        assert register(booking, now).created is True

    def test_cancelling_a_performed_payment_cancels_a_confirmed_booking(self, booking, now):
        payment = register(booking, now).payment
        services.complete_payment(provider="payme", external_id=payment.external_id, now=now)
        result = services.cancel_transaction(
            provider="payme", external_id=payment.external_id, now=now, raw={"reason": 5}
        )
        payment.refresh_from_db()
        booking.refresh_from_db()
        assert result.was_performed is True
        assert payment.status == PaymentStatus.REFUNDED
        assert payment.refunded_amount == AMOUNT
        assert booking.status == S.CANCELLED
        assert booking.refund_amount == AMOUNT
        refund = Refund.objects.get()
        assert refund.status == RefundStatus.DONE and refund.reason == RefundReason.PROVIDER

    def test_provider_refund_completes_a_manual_refund_we_were_waiting_for(self, booking, now):
        payment = register(booking, now).payment
        services.complete_payment(provider="payme", external_id=payment.external_id, now=now)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        refund = Refund.objects.get()
        Refund.objects.filter(pk=refund.pk).update(status=RefundStatus.MANUAL)
        services.cancel_transaction(provider="payme", external_id=payment.external_id, now=now)
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE
        assert Refund.objects.count() == 1  # no second refund record
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.REFUNDED

    @pytest.mark.parametrize("status", [S.ACTIVE, S.OVERSTAY, S.COMPLETED])
    def test_a_performed_payment_of_a_used_booking_cannot_be_cancelled(self, booking, now, status):
        payment = make_payment(booking, status=PaymentStatus.PAID, performed_at=now)
        force_status(booking, status, paid_amount=AMOUNT)
        with pytest.raises(errors.OrderCompleted):
            services.cancel_transaction(provider="payme", external_id=payment.external_id, now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.PAID

    def test_performed_payment_of_an_already_cancelled_booking_just_closes(self, booking, now):
        payment = make_payment(booking, status=PaymentStatus.PAID, performed_at=now)
        force_status(booking, S.CANCELLED, paid_amount=AMOUNT, refund_amount=AMOUNT)
        services.cancel_transaction(provider="payme", external_id=payment.external_id, now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.REFUNDED


class TestRaceBetweenExpiryAndPayment:
    """One winner, whichever comes first (the lot + booking locks serialise them on PostgreSQL;
    here the two orders are replayed one after the other)."""

    def test_payment_first_then_expiry(self, booking, now):
        payment = register(booking, now).payment
        services.complete_payment(provider="payme", external_id=payment.external_id, now=now)
        assert booking_services.expire_hold(booking.pk, now=now + timedelta(hours=1)) is False
        booking.refresh_from_db()
        assert booking.status == S.CONFIRMED

    def test_expiry_first_then_payment(self, booking, now):
        payment = register(booking, now).payment
        assert booking_services.expire_hold(booking.pk, now=now + timedelta(hours=1)) is True
        with pytest.raises(errors.OrderNotPayable):
            services.complete_payment(
                provider="payme", external_id=payment.external_id, now=now + timedelta(hours=1)
            )
        booking.refresh_from_db()
        assert booking.status == S.EXPIRED


def test_make_refund_factory_roundtrip(booking):
    payment = make_payment(booking, status=PaymentStatus.PAID)
    assert make_refund(payment).payment_id == payment.pk
