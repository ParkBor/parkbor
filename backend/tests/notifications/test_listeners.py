"""Hooks -> notify(): each booking / refund fact produces exactly one notification."""

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.bookings import hooks, services, sweeps
from apps.bookings.state import BookingStatus
from apps.core import events
from apps.notifications import events as ev
from apps.notifications.models import NotificationLog
from apps.parking.models import Slot
from apps.payments import lifecycle, refunds
from apps.payments.models import RefundReason, RefundStatus
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _queue(enqueued):
    return enqueued


@pytest.fixture
def world():
    return make_world(slots=3)


@pytest.fixture
def driver():
    return make_user("DRIVER")


@pytest.fixture
def now():
    return timezone.now().replace(second=0, microsecond=0)


def booking_for(driver, world, now, *, status, slot=0, start_h=3, end_h=4, **extra):
    return make_booking(
        user=driver,
        slot=world.slots[slot],
        vehicle=make_vehicle(driver),
        start=now + timedelta(hours=start_h),
        end=now + timedelta(hours=end_h),
        status=status,
        **extra,
    )


def logs():
    return list(NotificationLog.objects.order_by("created_at").values_list("event", "dedupe_key"))


# --- booking status ---------------------------------------------------------------------------


def test_confirming_a_booking_notifies_the_driver(
    driver, world, now, django_capture_on_commit_callbacks
):
    booking = booking_for(
        driver,
        world,
        now,
        status=BookingStatus.PENDING_PAYMENT,
        hold_expires_at=now + timedelta(minutes=5),
    )
    with django_capture_on_commit_callbacks(execute=True):
        services.confirm_booking(booking.pk, paid_amount=Decimal("12000"))
    assert logs() == [(ev.BOOKING_CONFIRMED, str(booking.pk))]


def test_cancelling_notifies_once_even_if_repeated(
    driver, world, now, django_capture_on_commit_callbacks
):
    booking = booking_for(driver, world, now, status=BookingStatus.CONFIRMED)
    with django_capture_on_commit_callbacks(execute=True):
        services.cancel_booking(booking_id=booking.pk, user=driver)
        services.cancel_booking(booking_id=booking.pk, user=driver)
    cancelled = [row for row in logs() if row[0] == ev.BOOKING_CANCELLED]
    assert cancelled == [(ev.BOOKING_CANCELLED, str(booking.pk))]
    # the paid booking has no payment row here, so its refund is a manual one: also announced once
    assert [event for event, _ in logs()].count(ev.REFUND_MANUAL) == 1


def test_an_expired_hold_notifies(driver, world, now, django_capture_on_commit_callbacks):
    booking = booking_for(
        driver,
        world,
        now,
        status=BookingStatus.PENDING_PAYMENT,
        hold_expires_at=now - timedelta(minutes=1),
    )
    with django_capture_on_commit_callbacks(execute=True):
        assert sweeps.expire_hold(booking.pk) is True
    assert logs() == [(ev.BOOKING_EXPIRED, str(booking.pk))]


def test_a_no_show_notifies(driver, world, now, django_capture_on_commit_callbacks):
    booking = booking_for(driver, world, now, status=BookingStatus.CONFIRMED, start_h=-2, end_h=1)
    with django_capture_on_commit_callbacks(execute=True):
        assert sweeps.mark_no_shows() == 1
    assert logs() == [(ev.NO_SHOW, str(booking.pk))]


def test_other_transitions_send_nothing(driver, world, now, django_capture_on_commit_callbacks):
    booking = booking_for(driver, world, now, status=BookingStatus.ACTIVE, start_h=-2, end_h=1)
    with django_capture_on_commit_callbacks(execute=True):
        hooks.booking_status_changed(booking.pk, driver.pk, world.lot.pk, "COMPLETED", "ACTIVE")
        hooks.booking_status_changed(booking.pk, driver.pk, world.lot.pk, "ACTIVE", "CONFIRMED")
    assert logs() == []


def test_a_walk_in_status_change_sends_nothing():
    hooks.booking_status_changed(uuid.uuid4(), None, uuid.uuid4(), "CANCELLED", "CONFIRMED")
    assert logs() == []


# --- overstay -----------------------------------------------------------------------------------


def test_overstay_notifies_the_driver(driver, world, now, django_capture_on_commit_callbacks):
    booking = booking_for(driver, world, now, status=BookingStatus.ACTIVE, start_h=-3, end_h=-1)
    with django_capture_on_commit_callbacks(execute=True):
        assert sweeps.detect_overstays() == 1
    assert (ev.OVERSTAY_DETECTED, str(booking.pk)) in logs()


def test_overstay_of_a_walk_in_is_skipped(world):
    hooks.overstay_detected(uuid.uuid4(), world.lot.pk, None)
    assert logs() == []


def test_overstay_is_notified_once(driver, world):
    booking_id = uuid.uuid4()
    hooks.overstay_detected(booking_id, world.lot.pk, driver.pk)
    hooks.overstay_detected(booking_id, world.lot.pk, driver.pk)
    assert logs() == [(ev.OVERSTAY_DETECTED, str(booking_id))]


def test_a_reassignment_tells_the_driver_the_new_slot(driver, world, now):
    booking = booking_for(driver, world, now, status=BookingStatus.CONFIRMED)
    new_slot = world.slots[2]
    hooks.slot_reassigned(booking.pk, world.slots[0].pk, new_slot.pk, world.lot.pk)
    hooks.slot_reassigned(booking.pk, world.slots[0].pk, new_slot.pk, world.lot.pk)
    [log] = NotificationLog.objects.all()
    assert log.event == ev.SLOT_REASSIGNED and log.user_id == driver.pk
    assert log.context["slot"] == Slot.objects.get(pk=new_slot.pk).code


def test_a_second_move_is_a_new_message(driver, world, now):
    booking = booking_for(driver, world, now, status=BookingStatus.CONFIRMED)
    hooks.slot_reassigned(booking.pk, world.slots[0].pk, world.slots[1].pk, world.lot.pk)
    hooks.slot_reassigned(booking.pk, world.slots[1].pk, world.slots[2].pk, world.lot.pk)
    assert NotificationLog.objects.count() == 2


def test_an_overstay_conflict_tells_only_the_waiting_driver(driver, world, now):
    booking = booking_for(driver, world, now, status=BookingStatus.CONFIRMED)
    hooks.overstay_conflict(booking.pk, world.lot.pk)
    [log] = NotificationLog.objects.all()
    assert (log.event, log.user_id) == (ev.OVERSTAY_CONFLICT, driver.pk)
    assert not NotificationLog.objects.filter(user=world.owner).exists()


def test_a_conflict_for_an_unknown_booking_is_ignored(world):
    hooks.overstay_conflict(uuid.uuid4(), world.lot.pk)
    hooks.slot_reassigned(uuid.uuid4(), world.slots[0].pk, world.slots[1].pk, world.lot.pk)
    assert logs() == []


# --- refunds ----------------------------------------------------------------------------------


def make_refund(booking, status, amount="6000"):
    return lifecycle.create_refund(
        status=status,
        payment=None,
        booking=booking,
        amount=Decimal(amount),
        reason=RefundReason.BOOKING_CANCELLED,
        idempotency_key=f"cancel:{uuid.uuid4()}",
    )


@pytest.mark.parametrize(
    ("status", "event"),
    [
        (RefundStatus.DONE, ev.REFUND_DONE),
        (RefundStatus.MANUAL, ev.REFUND_MANUAL),
    ],
)
def test_final_refund_states_notify_the_driver(
    driver, world, now, django_capture_on_commit_callbacks, status, event
):
    booking = booking_for(driver, world, now, status=BookingStatus.CANCELLED)
    refund = make_refund(booking, status)
    with django_capture_on_commit_callbacks(execute=True):
        refunds._record_status(refund, booking)
        refunds._record_status(refund, booking)  # a sweep repairing the same refund
    [log] = NotificationLog.objects.all()
    assert (log.event, log.dedupe_key, log.user_id) == (event, str(refund.pk), driver.pk)
    assert Decimal(log.context["amount"]) == Decimal("6000")


def test_a_failed_refund_notifies(driver, world, now, django_capture_on_commit_callbacks):
    booking = booking_for(driver, world, now, status=BookingStatus.CANCELLED)
    refund = make_refund(booking, RefundStatus.MANUAL)
    refund.status = RefundStatus.FAILED  # in memory only: a FAILED row needs a payment
    with django_capture_on_commit_callbacks(execute=True):
        refunds._record_status(refund, booking)
    assert logs() == [(ev.REFUND_FAILED, str(refund.pk))]


def test_a_pending_refund_says_nothing_yet(driver, world, now, django_capture_on_commit_callbacks):
    booking = booking_for(driver, world, now, status=BookingStatus.CANCELLED)
    refund = make_refund(booking, RefundStatus.MANUAL)
    refund.status = RefundStatus.PENDING  # in memory only: a PENDING row needs a payment
    with django_capture_on_commit_callbacks(execute=True):
        refunds._record_status(refund, booking)
    assert logs() == []


def test_a_manual_refund_created_by_a_cancel_notifies_after_commit(
    driver, world, now, django_capture_on_commit_callbacks
):
    booking = booking_for(driver, world, now, status=BookingStatus.CONFIRMED, start_h=3, end_h=4)
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        refunds._manual_refund(booking, Decimal("5000"), f"cancel:{booking.pk}", "no_paid_payment")
    assert logs() == []  # nothing before the commit
    for callback in callbacks:
        callback()
    assert [event for event, _ in logs()] == [ev.REFUND_MANUAL]


def test_the_listener_registry_keeps_a_failing_listener_from_breaking_the_caller(caplog):
    def broken(**kwargs):
        raise RuntimeError("listener bug")

    events.subscribe("probe", broken)
    try:
        events.emit("probe", x=1)
    finally:
        events.unsubscribe("probe", broken)
    assert "listener bug" in caplog.text or "failed" in caplog.text


def test_registration_is_idempotent():
    from apps.notifications.apps import register_listeners

    before = {k: list(v) for k, v in events._listeners.items()}
    register_listeners()
    assert {k: list(v) for k, v in events._listeners.items()} == before
