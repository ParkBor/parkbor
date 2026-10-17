"""Real PostgreSQL behaviour of payments: unique (provider, external_id) under parallel callbacks,
webhook vs expire_hold / cancel races (lot-first locking, no deadlock), 40P01 / 55P03 mapping.
Skipped locally (no PostGIS); MUST run in CI (REQUIRE_POSTGIS=1)."""

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from unittest import mock

import pytest
from django.db import IntegrityError, OperationalError, connection, transaction
from django.utils import timezone

from apps.bookings import services as booking_services
from apps.bookings.errors import SerializationRetry
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError
from apps.payments import errors, services
from apps.payments.models import Payment, PaymentStatus, Refund
from tests.bookings.factories import FakePgError, make_booking, make_vehicle, make_world
from tests.helpers import make_user
from tests.payments.factories import make_payment

pytestmark = [pytest.mark.postgis, pytest.mark.django_db(transaction=True)]
AMOUNT = Decimal("12000.00")
# pytest-timeout is not installed, so a hung thread would block the pool's teardown: every wait
# is bounded here and by the database (test settings: lock_timeout 20 s, statement_timeout 60 s;
# the CI job has timeout-minutes: 15). PAYMENTS_LOCK_TIMEOUT_SECONDS is 30 in test settings
# because the parallel jobs queue on one lot lock.
TIMEOUT = 90


def run_parallel(jobs):
    barrier = threading.Barrier(len(jobs))

    def wrap(job):
        def run():
            try:
                barrier.wait(timeout=30)
                return True, job()
            except BaseException as exc:  # noqa: BLE001 - reported to the assertions
                return False, exc
            finally:
                connection.close()

        return run

    pool = ThreadPoolExecutor(max_workers=len(jobs))
    try:
        return [f.result(timeout=TIMEOUT) for f in [pool.submit(wrap(j)) for j in jobs]]
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def pending_booking(world, now, n=0, hold_minutes=10):
    user = make_user("DRIVER")
    return make_booking(
        user=user,
        slot=world.slots[n],
        vehicle=make_vehicle(user),
        start=now + timedelta(hours=2),
        end=now + timedelta(hours=4),
        hold_expires_at=now + timedelta(minutes=hold_minutes),
        payment_provider="payme",
    )


def register(booking, now, tx):
    return services.register_transaction(
        booking_id=booking.pk, provider="payme", external_id=tx, amount=AMOUNT, now=now
    )


def test_unique_index_exists_in_the_database():
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_indexes WHERE indexname = 'payment_provider_ext'")
        assert cursor.fetchone()


def test_raw_duplicate_provider_transaction_is_refused():
    world = make_world(slots=2)
    now = timezone.now()
    first = pending_booking(world, now)
    make_payment(first, external_id="d" * 24, status=PaymentStatus.PAID)
    with pytest.raises(IntegrityError), transaction.atomic():
        make_payment(first, external_id="d" * 24, status=PaymentStatus.PAID)


def test_two_parallel_performs_confirm_once():
    world = make_world(slots=1)
    now = timezone.now()
    booking = pending_booking(world, now)
    tx = "a" * 24
    register(booking, now, tx)
    results = run_parallel(
        [
            lambda: services.complete_payment(provider="payme", external_id=tx, now=now),
            lambda: services.complete_payment(provider="payme", external_id=tx, now=now),
        ]
    )
    assert all(ok for ok, _ in results), results
    outcomes = sorted(r.outcome.value for _, r in results)
    assert outcomes == ["ALREADY_PAID", "PAID"]
    booking.refresh_from_db()
    assert booking.status == S.CONFIRMED and booking.paid_amount == AMOUNT
    assert booking.events.filter(reason="payment_confirmed").count() == 1


def test_parallel_create_with_one_transaction_id_for_two_orders_has_one_winner():
    now = timezone.now()
    worlds = [make_world(slots=1), make_world(slots=1)]  # two lots: no shared lot lock
    bookings = [pending_booking(w, now) for w in worlds]
    results = run_parallel([lambda b=b: register(b, now, "u" * 24) for b in bookings])
    wins = [r for ok, r in results if ok]
    losses = [r for ok, r in results if not ok]
    assert len(wins) == 1
    assert len(losses) == 1 and isinstance(losses[0], errors.ConflictingTransaction)
    assert Payment.objects.filter(external_id="u" * 24).count() == 1


def test_parallel_create_for_the_same_order_and_transaction_is_idempotent():
    world = make_world(slots=1)
    now = timezone.now()
    booking = pending_booking(world, now)
    results = run_parallel([lambda: register(booking, now, "s" * 24) for _ in range(8)])
    assert all(ok for ok, _ in results), results
    assert sum(1 for _, r in results if r.created) == 1
    assert Payment.objects.count() == 1


def test_parallel_creates_with_different_ids_for_one_order_leave_one_open_transaction():
    world = make_world(slots=1)
    now = timezone.now()
    booking = pending_booking(world, now)
    results = run_parallel([lambda i=i: register(booking, now, f"{i:024d}") for i in range(6)])
    assert sum(1 for ok, _ in results if ok) == 1
    assert all(isinstance(r, errors.ConflictingTransaction) for ok, r in results if not ok)
    assert Payment.objects.filter(status=PaymentStatus.PENDING).count() == 1


@pytest.mark.parametrize("round_", range(5))
def test_perform_versus_expire_hold_has_exactly_one_winner(round_):
    world = make_world(slots=1)
    now = timezone.now()
    booking = pending_booking(world, now)
    tx = f"{round_:024d}"
    register(booking, now, tx)
    late = now + timedelta(minutes=30)  # the hold is over: both want the same booking
    results = run_parallel(
        [
            lambda: services.complete_payment(provider="payme", external_id=tx, now=late),
            lambda: booking_services.expire_hold(booking.pk, now=late),
        ]
    )
    for ok, value in results:
        assert ok or isinstance(value, errors.OrderNotPayable | ApiError), value
    booking.refresh_from_db()
    payment = Payment.objects.get()
    if booking.status == S.CONFIRMED:
        assert payment.status == PaymentStatus.PAID and booking.paid_amount == AMOUNT
    else:
        assert booking.status == S.EXPIRED
        assert payment.status == PaymentStatus.PENDING and booking.paid_amount == 0
    assert not Refund.objects.exists()


def test_perform_versus_cancel_and_create_in_one_lot_finish_without_deadlock():
    world = make_world(slots=4)
    now = timezone.now()
    booking = pending_booking(world, now, n=0)
    register(booking, now, "z" * 24)
    other = make_user("DRIVER")
    other_vehicle = make_vehicle(other)
    results = run_parallel(
        [
            lambda: services.complete_payment(provider="payme", external_id="z" * 24, now=now),
            lambda: booking_services.cancel_booking(
                booking_id=booking.pk, user=booking.user, now=now
            ),
            lambda: booking_services.create_booking(
                user=other,
                lot_id=world.lot.pk,
                slot_type="STANDARD",
                vehicle=other_vehicle,
                start=now + timedelta(hours=8),
                end=now + timedelta(hours=9),
                now=now,
            ),
        ]
    )
    unexpected = [
        r for ok, r in results if not ok and not isinstance(r, errors.PaymentError | ApiError)
    ]
    assert not unexpected, unexpected  # no OperationalError("deadlock detected"), no hangs
    booking.refresh_from_db()
    if booking.status == S.CANCELLED and booking.paid_amount > 0:
        assert Refund.objects.filter(booking=booking).exists()  # paid then cancelled: refunded
    if booking.status == S.CANCELLED and booking.paid_amount == 0:
        assert not Refund.objects.exists()


class TestDeadlockAndTimeoutMapping:
    def deadlock(self):
        error = OperationalError("deadlock detected")
        error.__cause__ = FakePgError("40P01")
        return error

    def test_one_deadlock_is_retried_transparently(self, booking_pg):
        booking, now = booking_pg
        real = booking_services._lock_lot
        calls = []

        def flaky(lot_id):
            """1st call: the deadlock. 2nd call: the real lock, INSIDE the retried transaction
            (select_for_update needs an open transaction, so it cannot be pre-computed)."""
            calls.append(lot_id)
            if len(calls) == 1:
                raise self.deadlock()
            return real(lot_id)

        with (
            mock.patch.object(booking_services, "_lock_lot", side_effect=flaky),
            mock.patch.object(booking_services.time, "sleep"),
        ):
            result = register(booking, now, "r" * 24)
        assert result.created is True and len(calls) == 2

    def test_a_second_deadlock_surfaces_as_serialization_retry(self, booking_pg):
        booking, now = booking_pg
        with (
            mock.patch.object(
                booking_services, "_lock_lot", side_effect=[self.deadlock(), self.deadlock()]
            ),
            mock.patch.object(booking_services.time, "sleep"),
            pytest.raises(SerializationRetry),
        ):
            register(booking, now, "r" * 24)

    def test_lock_timeout_is_not_retried(self, booking_pg):
        booking, now = booking_pg
        timeout = OperationalError("lock timeout")
        timeout.__cause__ = FakePgError("55P03")
        with (
            mock.patch.object(booking_services, "_lock_lot", side_effect=timeout) as lock,
            pytest.raises(ApiError) as caught,
        ):
            register(booking, now, "r" * 24)
        assert lock.call_count == 1
        assert str(caught.value.detail["code"]) == "lock_timeout"


@pytest.fixture
def booking_pg():
    world = make_world(slots=1)
    now = timezone.now()
    return pending_booking(world, now), now


def test_webhook_takes_the_lot_lock_before_the_booking_row():
    world = make_world(slots=1)
    now = timezone.now()
    booking = pending_booking(world, now)
    register(booking, now, "o" * 24)
    order = []
    real_lot, real_row = booking_services._lock_lot, booking_services._lock_booking_row
    with (
        mock.patch.object(
            booking_services, "_lock_lot", lambda i: (order.append("lot"), real_lot(i))[1]
        ),
        mock.patch.object(
            booking_services,
            "_lock_booking_row",
            lambda i: (order.append("booking"), real_row(i))[1],
        ),
    ):
        services.complete_payment(provider="payme", external_id="o" * 24, now=now)
    assert order[:2] == ["lot", "booking"]
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


def confirmed_paid(world, now, n=0):
    booking = pending_booking(world, now, n=n)
    tx = f"c{n:023d}"
    register(booking, now, tx)
    services.complete_payment(provider="payme", external_id=tx, now=now)
    return booking, Payment.objects.get(external_id=tx)


@pytest.mark.parametrize("round_", range(3))
def test_parallel_cancel_and_operator_retry_never_refund_the_same_money_twice(round_):
    """cancel_booking (creates a refund) races resolve_manual_refund(--retry) on an automatic
    FAILED refund that already holds the whole payment: the reserve invariant must survive."""
    from apps.payments import refunds
    from apps.payments.models import RefundStatus
    from tests.payments.factories import make_refund

    world = make_world(slots=1)
    now = timezone.now()
    booking, payment = confirmed_paid(world, now)
    failed = make_refund(
        payment, status=RefundStatus.FAILED, key=f"auto:{payment.pk}", last_error="click_error_-5"
    )
    Payment.objects.filter(pk=payment.pk).update(refunded_amount=payment.amount)
    admin = make_user("ADMIN")
    results = run_parallel(
        [
            lambda: booking_services.cancel_booking(
                booking_id=booking.pk, user=booking.user, now=now
            ),
            lambda: refunds.resolve_manual_refund(failed.pk, "retry", actor=admin, now=now),
        ]
    )
    for ok, value in results:
        assert ok or isinstance(value, ApiError), value
    payment.refresh_from_db()
    assert refunds.reserved_total(payment) == payment.refunded_amount <= payment.amount
    automatic = Refund.objects.filter(payment=payment).exclude(status=RefundStatus.MANUAL)
    assert sum(r.amount for r in automatic) <= payment.amount


def test_two_operators_resolving_the_same_manual_refund_have_one_winner():
    from apps.payments import refunds
    from apps.payments.models import RefundStatus
    from tests.payments.factories import make_refund

    world = make_world(slots=1)
    now = timezone.now()
    booking, payment = confirmed_paid(world, now)
    manual = make_refund(payment, status=RefundStatus.MANUAL, key=f"m:{payment.pk}")
    Payment.objects.filter(pk=payment.pk).update(refunded_amount=payment.amount)
    first, second = make_user("ADMIN"), make_user("ADMIN")
    results = run_parallel(
        [
            lambda: refunds.resolve_manual_refund(manual.pk, "done", actor=first, now=now),
            lambda: refunds.resolve_manual_refund(manual.pk, "failed", actor=second, now=now),
        ]
    )
    assert sum(1 for ok, _ in results if ok) == 1
    assert all(isinstance(v, ApiError) for ok, v in results if not ok)
    payment.refresh_from_db()
    assert refunds.reserved_total(payment) == payment.refunded_amount
