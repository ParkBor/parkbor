"""send_reminders boundaries, housekeeping tasks, receipts and the beat schedule."""

import logging
import uuid
from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone
from freezegun import freeze_time

from apps.accounts.models import Device
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.notifications import dispatcher, maintenance, receipts, reminders, tasks
from apps.notifications import events as ev
from apps.notifications.channels import expo_push
from apps.notifications.channels.expo_push import PushOutcome, PushResult
from apps.notifications.models import NotificationLog
from config.celery import CELERY_BEAT_SCHEDULE, app
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user
from tests.notifications.conftest import TOKEN, make_driver

pytestmark = pytest.mark.django_db


@pytest.fixture
def world():
    return make_world(slots=4)


@pytest.fixture
def now():
    return timezone.now().replace(second=0, microsecond=0)


def booking_ending_in(world, now, minutes, *, status=S.CONFIRMED, slot=0, user="driver"):
    driver = make_user("DRIVER")
    booking = make_booking(
        user=driver,
        slot=world.slots[slot],
        vehicle=make_vehicle(driver),
        start=now - timedelta(hours=1) if minutes < 60 else now,
        end=now + timedelta(minutes=minutes),
        status=status,
    )
    if user != "driver":  # a walk-in has neither an account nor a vehicle record
        Booking.objects.filter(pk=booking.pk).update(user=None, vehicle=None, kind="WALK_IN")
    return booking


# --- send_reminders --------------------------------------------------------------------------


def reminded():
    return set(
        NotificationLog.objects.filter(event=ev.REMINDER_15M_LEFT).values_list(
            "dedupe_key", flat=True
        )
    )


def test_a_booking_ending_in_exactly_15_minutes_is_reminded(world, now, enqueued):
    booking = booking_ending_in(world, now, 15)
    assert reminders.send_reminders(now=now) == 1
    assert reminded() == {str(booking.pk)}


def test_a_booking_ending_in_15_minutes_and_a_second_is_not_yet(world, now, enqueued):
    booking_ending_in(world, now, 15)
    assert reminders.send_reminders(now=now - timedelta(seconds=1)) == 0
    assert reminders.send_reminders(now=now) == 1


def test_a_booking_that_already_ended_is_not_reminded(world, now, enqueued):
    booking_ending_in(world, now, 0)
    booking_ending_in(world, now, -5, slot=1)
    assert reminders.send_reminders(now=now) == 0


@pytest.mark.parametrize("status", [S.CONFIRMED, S.ACTIVE])
def test_confirmed_and_active_bookings_are_reminded(world, now, enqueued, status):
    booking_ending_in(world, now, 10, status=status)
    assert reminders.send_reminders(now=now) == 1


@pytest.mark.parametrize(
    "status", [S.PENDING_PAYMENT, S.OVERSTAY, S.COMPLETED, S.CANCELLED, S.EXPIRED, S.NO_SHOW]
)
def test_other_statuses_are_not_reminded(world, now, enqueued, status):
    booking_ending_in(world, now, 10, status=status)
    assert reminders.send_reminders(now=now) == 0


def test_a_walk_in_is_never_reminded(world, now, enqueued):
    booking_ending_in(world, now, 10, user=None)
    assert reminders.send_reminders(now=now) == 0


def test_each_booking_is_reminded_exactly_once_over_many_runs(world, now, enqueued):
    booking_ending_in(world, now, 15)
    total = 0
    for minute in range(16):  # the sweep runs every minute until the end
        total += reminders.send_reminders(now=now + timedelta(minutes=minute))
    assert total == 1 and NotificationLog.objects.count() == 1


def test_the_batch_limit_is_respected_and_the_rest_follows_next_run(world, now, enqueued):
    for slot in range(3):
        booking_ending_in(world, now, 10 + slot, slot=slot)
    assert reminders.send_reminders(now=now, limit=2) == 2
    assert reminders.send_reminders(now=now, limit=2) == 1


def test_one_failing_booking_does_not_stop_the_others(world, now, enqueued, monkeypatch, caplog):
    first = booking_ending_in(world, now, 10, slot=0)
    booking_ending_in(world, now, 11, slot=1)
    real = dispatcher.notify

    def flaky(user_id, event, context=None, *, dedupe_key):
        if dedupe_key == first.pk:
            raise RuntimeError("database hiccup")
        return real(user_id, event, context, dedupe_key=dedupe_key)

    monkeypatch.setattr(reminders, "notify", flaky)
    with caplog.at_level(logging.ERROR):
        assert reminders.send_reminders(now=now) == 1
    assert str(first.pk) not in reminded()


def test_the_task_uses_the_current_time(world, enqueued):
    now = timezone.now().replace(microsecond=0)
    booking_ending_in(world, now, 10)
    assert tasks.send_reminders.apply().get() == 1


# --- housekeeping -----------------------------------------------------------------------------


def test_devices_unseen_for_90_days_are_pruned(now):
    user = make_driver()
    old = Device.objects.create(user=user, platform="ios", expo_push_token="ExpoPushToken[old]")
    fresh = Device.objects.create(user=user, platform="ios", expo_push_token="ExpoPushToken[new]")
    edge = Device.objects.create(user=user, platform="ios", expo_push_token="ExpoPushToken[edge]")
    Device.objects.filter(pk=old.pk).update(last_seen=now - timedelta(days=91))
    Device.objects.filter(pk=edge.pk).update(last_seen=now - timedelta(days=89))
    assert maintenance.prune_devices(now=now) == 1
    assert set(Device.objects.values_list("pk", flat=True)) == {fresh.pk, edge.pk}


def test_old_log_rows_are_purged_after_180_days(now):
    user = make_driver()
    rows = [
        NotificationLog.objects.create(user=user, event=ev.NO_SHOW, dedupe_key=str(i))
        for i in range(3)
    ]
    NotificationLog.objects.filter(pk=rows[0].pk).update(created_at=now - timedelta(days=181))
    NotificationLog.objects.filter(pk=rows[1].pk).update(created_at=now - timedelta(days=179))
    assert maintenance.purge_logs(now=now) == 1
    assert NotificationLog.objects.count() == 2


def test_purge_works_in_batches(now, monkeypatch):
    monkeypatch.setattr(maintenance, "DELETE_BATCH", 2)
    user = make_driver()
    for i in range(5):
        NotificationLog.objects.create(user=user, event=ev.NO_SHOW, dedupe_key=str(i))
    NotificationLog.objects.update(created_at=now - timedelta(days=400))
    assert maintenance.purge_logs(now=now) == 5


def test_stale_pending_rows_are_queued_again(now, enqueued):
    user = make_driver()
    stale = NotificationLog.objects.create(user=user, event=ev.NO_SHOW, dedupe_key="a")
    young = NotificationLog.objects.create(user=user, event=ev.NO_SHOW, dedupe_key="b")
    leased = NotificationLog.objects.create(user=user, event=ev.NO_SHOW, dedupe_key="c")
    sent = NotificationLog.objects.create(
        user=user, event=ev.NO_SHOW, dedupe_key="d", status=NotificationLog.Status.SENT
    )
    old = now - timedelta(minutes=10)
    NotificationLog.objects.filter(pk__in=[stale.pk, leased.pk, sent.pk]).update(updated_at=old)
    NotificationLog.objects.filter(pk=leased.pk).update(lease_until=now + timedelta(minutes=1))
    assert maintenance.resend_pending(now=now) == 1
    assert enqueued == [([str(stale.pk)], None)]
    assert young.pk != stale.pk


def test_resend_survives_a_broker_outage(now, monkeypatch):
    monkeypatch.setattr(tasks.send_notification, "apply_async", mock.Mock(side_effect=OSError))
    user = make_driver()
    row = NotificationLog.objects.create(user=user, event=ev.NO_SHOW, dedupe_key="a")
    NotificationLog.objects.filter(pk=row.pk).update(updated_at=now - timedelta(hours=1))
    assert maintenance.resend_pending(now=now) == 0


def test_send_task_requeues_itself_with_the_requested_delay(monkeypatch, enqueued, expo):
    user = make_driver(devices=[TOKEN])
    log = NotificationLog.objects.create(
        user=user, event=ev.NO_SHOW, dedupe_key="x", context={"booking_id": str(uuid.uuid4())}
    )
    expo.script = [PushResult(PushOutcome.RETRY, "MessageRateExceeded")]
    assert tasks.send_notification.apply(args=(str(log.pk),)).get() is False
    assert enqueued == [([str(log.pk)], 30)]
    assert tasks.send_notification.apply(args=(str(log.pk),)).get() is True


# --- receipts ---------------------------------------------------------------------------------


def test_tickets_are_remembered_and_dead_devices_removed(fake_redis, monkeypatch):
    user = make_driver(devices=[TOKEN])
    receipts.remember("t1", TOKEN, now=1000)
    receipts.remember("t2", "ExponentPushToken[other]", now=1000)
    receipts.remember("t3", "ExponentPushToken[late]", now=5000)  # too young
    monkeypatch.setattr(
        expo_push,
        "get_receipts",
        lambda ids: {
            "t1": PushResult(PushOutcome.INVALID_TOKEN, "DeviceNotRegistered"),
            "t2": PushResult(PushOutcome.OK),
        },
    )
    counts = receipts.check_receipts(now=1000 + receipts.RECEIPT_DELAY_SECONDS + 1)
    assert counts == {"checked": 2, "pruned": 1, "pending": 0, "expired": 0}
    assert not Device.objects.filter(user=user).exists()
    assert fake_redis.zcard(receipts.KEY) == 1  # only the young one is left


def test_receipts_not_ready_are_kept_until_they_expire(fake_redis, monkeypatch):
    receipts.remember("t1", TOKEN, now=1000)
    monkeypatch.setattr(expo_push, "get_receipts", lambda ids: {})
    assert receipts.check_receipts(now=1000 + 1000)["pending"] == 1
    assert fake_redis.zcard(receipts.KEY) == 1
    receipts.check_receipts(now=1000 + receipts.RECEIPT_MAX_AGE_SECONDS + 10)
    assert fake_redis.zcard(receipts.KEY) == 0


def test_receipt_checks_survive_redis_being_down(fake_redis, monkeypatch):
    import redis

    monkeypatch.setattr(fake_redis, "zrangebyscore", mock.Mock(side_effect=redis.ConnectionError))
    assert receipts.check_receipts(now=10**9) == {
        "checked": 0,
        "pruned": 0,
        "pending": 0,
        "expired": 0,
    }
    monkeypatch.setattr(fake_redis, "zadd", mock.Mock(side_effect=redis.ConnectionError))
    receipts.remember("t", TOKEN)  # must not raise


def test_a_delivered_push_leaves_a_ticket_for_the_receipt_check(fake_redis, expo):
    from apps.notifications import delivery

    user = make_driver(devices=[TOKEN])
    log = NotificationLog.objects.create(
        user=user, event=ev.NO_SHOW, dedupe_key="x", context={"booking_id": str(uuid.uuid4())}
    )
    expo.by_token = {TOKEN: PushResult(PushOutcome.OK, ticket_id="ticket-9")}
    delivery.deliver(log.pk)
    assert fake_redis.zrange(receipts.KEY, 0, -1) == [f"ticket-9|{TOKEN}"]


# --- schedule -----------------------------------------------------------------------------------


def test_beat_schedule_has_the_notification_jobs():
    jobs = {k: v for k, v in CELERY_BEAT_SCHEDULE.items() if v["task"].startswith("notifications.")}
    assert {j["task"]: j["schedule"] for j in jobs.values()} == {
        "notifications.send_reminders": 60.0,
        "notifications.resend_pending": 300.0,
        "notifications.check_push_receipts": 900.0,
        "notifications.prune_push_tokens": 86400.0,
        "notifications.purge_notification_log": 86400.0,
    }
    assert app.conf.beat_schedule == CELERY_BEAT_SCHEDULE


def test_every_notification_task_is_registered():
    app.finalize()
    app.loader.import_default_modules()
    for name in (
        "notifications.send",
        "notifications.send_reminders",
        "notifications.resend_pending",
        "notifications.check_push_receipts",
        "notifications.prune_push_tokens",
        "notifications.purge_notification_log",
        "realtime.flush_availability",
    ):
        assert name in app.tasks


def test_the_send_task_is_acks_late_and_rate_limited():
    assert tasks.send_notification.acks_late is True
    assert tasks.send_notification.rate_limit == "25/s"


def test_frozen_clock_does_not_confuse_the_reminder_window(world, enqueued):
    with freeze_time("2026-10-17 10:00:00"):
        now = timezone.now()
        booking_ending_in(world, now, 15)
        assert reminders.send_reminders() == 1
