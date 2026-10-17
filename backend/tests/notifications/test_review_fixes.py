"""Review fixes: poison messages, partial delivery, backoff vs resend, clamps, reminders paging,
receipt batches, device limit, availability events from parking, slot code charset."""

import logging
import math
import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts import services as account_services
from apps.accounts.models import Device
from apps.core import events
from apps.notifications import delivery, maintenance, messages, receipts, reminders, tasks
from apps.notifications import events as ev
from apps.notifications.channels import expo_push
from apps.notifications.channels.expo_push import PushOutcome, PushResult
from apps.notifications.channels.telegram import TelegramOutcome, TelegramResult
from apps.notifications.models import NotificationLog
from apps.parking import services as parking_services
from apps.parking.models import ParkingLot
from tests.bookings.factories import make_world
from tests.helpers import client_for, make_user
from tests.notifications.conftest import TOKEN, make_driver

pytestmark = pytest.mark.django_db
Status = NotificationLog.Status


def make_log(user, event=ev.BOOKING_CONFIRMED, **context):
    booking_id = context.pop("booking_id", str(uuid.uuid4()))
    return NotificationLog.objects.create(
        user=user, event=event, dedupe_key=booking_id, context={"booking_id": booking_id, **context}
    )


def fresh(log):
    log.refresh_from_db()
    return log


# --- poison messages ----------------------------------------------------------------------------


def test_a_poison_message_ends_as_failed_after_the_attempt_limit(monkeypatch):
    user = make_driver(devices=[TOKEN])
    log = make_log(user)

    def boom(*args, **kwargs):
        raise RuntimeError("template bug")

    monkeypatch.setattr(delivery, "_push", boom)
    waits = [delivery.deliver(log.pk).retry_in for _ in range(delivery.MAX_ATTEMPTS)]
    assert waits == [30, 60, 120, 240, None]
    log = fresh(log)
    assert (log.status, log.last_error, log.attempts) == (Status.FAILED, "internal_error", 5)
    assert delivery.deliver(log.pk).retry_in is None  # nothing is ever retried again


def test_a_crash_after_a_delivery_keeps_the_delivered_channel(expo, tg, monkeypatch):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    log = make_log(user, ev.OVERSTAY_DETECTED)  # critical: push AND telegram
    real = delivery._telegram
    calls = []

    def crash_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("telegram client bug")
        return real(*args, **kwargs)

    monkeypatch.setattr(delivery, "_telegram", crash_once)
    assert delivery.deliver(log.pk).retry_in == 30
    log = fresh(log)
    assert (log.status, log.delivered) == (Status.PENDING, "push")
    assert delivery.deliver(log.pk).retry_in is None
    assert len(expo.messages) == 1  # push was NOT sent a second time
    assert len(tg.sent) == 1
    assert (fresh(log).status, fresh(log).delivered) == (Status.SENT, "push+telegram")


def test_a_poison_telegram_leg_still_counts_the_push_as_sent(expo, monkeypatch):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    log = make_log(user, ev.OVERSTAY_DETECTED)
    monkeypatch.setattr(
        delivery, "_telegram", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("bug"))
    )
    for _ in range(delivery.MAX_ATTEMPTS):
        delivery.deliver(log.pk)
    assert (fresh(log).status, fresh(log).delivered) == (Status.SENT, "push")


# --- backoff and resend -----------------------------------------------------------------------------


def test_a_retry_records_when_the_next_attempt_is_due(expo):
    user = make_driver(devices=[TOKEN])
    expo.script = [PushResult(PushOutcome.RETRY, "x", retry_after=90)]
    log = make_log(user)
    now = timezone.now()
    assert delivery.deliver(log.pk, now=now).retry_in == 90
    assert fresh(log).next_attempt_at == now + timedelta(seconds=90)
    delivery.deliver(log.pk)
    assert fresh(log).next_attempt_at is None  # delivered: nothing is due


def test_resend_never_defeats_a_backoff(enqueued):
    user = make_driver()
    now = timezone.now()
    waiting = make_log(user)
    due = make_log(user)
    never_scheduled = make_log(user)
    old = now - timedelta(hours=1)
    NotificationLog.objects.update(updated_at=old)
    NotificationLog.objects.filter(pk=waiting.pk).update(
        next_attempt_at=now + timedelta(minutes=20)
    )
    NotificationLog.objects.filter(pk=due.pk).update(next_attempt_at=now - timedelta(minutes=10))
    assert maintenance.resend_pending(now=now) == 2
    queued = {args[0] for args, _ in enqueued}
    assert queued == {str(due.pk), str(never_scheduled.pk)}


def test_a_backoff_that_just_ended_is_given_time_to_run(enqueued):
    now = timezone.now()
    log = make_log(make_driver())
    NotificationLog.objects.filter(pk=log.pk).update(
        updated_at=now - timedelta(hours=1), next_attempt_at=now - timedelta(seconds=20)
    )
    assert maintenance.resend_pending(now=now) == 0  # its own retry task is about to run


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        (17, 17),
        (0, 1),
        (-5, 1),
        (10**9, delivery.BACKOFF_CAP_SECONDS),
        (math.inf, 30),
        (math.nan, 30),
        (None, 30),
        ("soon", 30),
        (True, 30),
    ],
)
def test_retry_after_is_clamped(requested, expected):
    assert delivery._wait(requested, 1) == expected


def test_a_huge_telegram_retry_after_cannot_park_a_row_for_days(tg):
    user = make_driver(telegram_on=True)
    tg.script = [TelegramResult(TelegramOutcome.RETRY, "telegram_429", retry_after=10**8)]
    log = make_log(user)
    assert delivery.deliver(log.pk).retry_in == delivery.BACKOFF_CAP_SECONDS


# --- reminders --------------------------------------------------------------------------------------


def test_reminded_bookings_at_the_front_cannot_starve_the_ones_behind(enqueued, monkeypatch):
    from apps.bookings.state import BookingStatus as S
    from tests.bookings.factories import make_booking, make_vehicle

    monkeypatch.setattr(reminders, "PAGE_SIZE", 2)
    world = make_world(slots=6)
    now = timezone.now().replace(microsecond=0)
    bookings = []
    for minute, slot in enumerate(world.slots, start=1):
        driver = make_user("DRIVER")
        bookings.append(
            make_booking(
                user=driver,
                slot=slot,
                vehicle=make_vehicle(driver),
                start=now - timedelta(hours=1),
                end=now + timedelta(minutes=minute),
                status=S.CONFIRMED,
            )
        )
    for booking in bookings[:4]:  # the four soonest are already reminded
        NotificationLog.objects.create(
            user=booking.user, event=ev.REMINDER_15M_LEFT, dedupe_key=str(booking.pk)
        )
    assert reminders.send_reminders(now=now, limit=2) == 2
    newly = NotificationLog.objects.filter(event=ev.REMINDER_15M_LEFT).count() - 4
    assert newly == 2


def test_the_reminder_text_uses_the_configured_minutes(settings):
    settings.NOTIFICATION_REMINDER_MINUTES = 20
    for language in ("uz", "ru", "en"):
        message = messages.render(ev.REMINDER_15M_LEFT, language, {})
        assert "20" in message.body and "15" not in message.body + message.title


# --- receipts ---------------------------------------------------------------------------------------


def test_remembered_tickets_expire_with_the_set(fake_redis):
    receipts.remember("t1", TOKEN, now=1000)
    assert 0 < fake_redis.ttl(receipts.KEY) <= receipts.KEY_TTL_SECONDS


def test_old_entries_are_trimmed_every_run(fake_redis, monkeypatch):
    receipts.remember("old", TOKEN, now=1000)
    monkeypatch.setattr(expo_push, "get_receipts", lambda ids: {})
    counts = receipts.check_receipts(now=1000 + receipts.RECEIPT_MAX_AGE_SECONDS + 5)
    assert counts["expired"] == 1 and fake_redis.zcard(receipts.KEY) == 0


def test_a_run_settles_several_batches(fake_redis, monkeypatch):
    monkeypatch.setattr(receipts, "BATCH", 2)
    for i in range(5):
        receipts.remember(f"t{i}", f"ExponentPushToken[d{i}]", now=1000 + i)
    monkeypatch.setattr(
        expo_push, "get_receipts", lambda ids: {i: PushResult(PushOutcome.OK) for i in ids}
    )
    counts = receipts.check_receipts(now=1000 + receipts.RECEIPT_DELAY_SECONDS + 100)
    assert counts["checked"] == 5 and fake_redis.zcard(receipts.KEY) == 0


def test_waiting_tickets_do_not_block_the_batches_behind_them(fake_redis, monkeypatch):
    monkeypatch.setattr(receipts, "BATCH", 2)
    for i in range(4):
        receipts.remember(f"t{i}", f"ExponentPushToken[d{i}]", now=1000 + i)
    ready = {"t2", "t3"}
    monkeypatch.setattr(
        expo_push,
        "get_receipts",
        lambda ids: {i: PushResult(PushOutcome.OK) for i in ids if i in ready},
    )
    counts = receipts.check_receipts(now=1000 + receipts.RECEIPT_DELAY_SECONDS + 100)
    assert (counts["checked"], counts["pending"]) == (2, 2)


# --- device limit -----------------------------------------------------------------------------------


def test_a_user_keeps_at_most_the_configured_number_of_devices(settings):
    settings.DEVICES_MAX_PER_USER = 2
    user = make_user("DRIVER")
    for i in range(3):
        account_services.register_device(
            user, platform="ios", expo_push_token=f"ExpoPushToken[dev{i}]"
        )
        Device.objects.filter(expo_push_token=f"ExpoPushToken[dev{i}]").update(
            last_seen=timezone.now() - timedelta(days=3 - i)
        )
    account_services.register_device(user, platform="ios", expo_push_token="ExpoPushToken[new]")
    tokens = set(Device.objects.filter(user=user).values_list("expo_push_token", flat=True))
    assert len(tokens) == 2 and "ExpoPushToken[new]" in tokens
    assert "ExpoPushToken[dev0]" not in tokens


def test_moving_a_token_between_accounts_is_logged(caplog):
    first, second = make_user("DRIVER"), make_user("DRIVER")
    account_services.register_device(first, platform="ios", expo_push_token="ExpoPushToken[x]")
    with caplog.at_level(logging.WARNING, logger="apps.accounts.services"):
        account_services.register_device(second, platform="ios", expo_push_token="ExpoPushToken[x]")
    assert "moved" in caplog.text and "ExpoPushToken" not in caplog.text
    assert Device.objects.get(expo_push_token="ExpoPushToken[x]").user_id == second.pk


def test_re_registering_the_same_token_is_not_a_move(caplog):
    user = make_user("DRIVER")
    account_services.register_device(user, platform="ios", expo_push_token="ExpoPushToken[x]")
    with caplog.at_level(logging.WARNING, logger="apps.accounts.services"):
        account_services.register_device(user, platform="ios", expo_push_token="ExpoPushToken[x]")
    assert "moved" not in caplog.text


# --- parking announces counter changes -----------------------------------------------------------------


@pytest.fixture
def seen():
    heard = []

    def listener(*, lot_id):
        heard.append(lot_id)

    events.subscribe("availability_changed", listener)
    yield heard
    events.unsubscribe("availability_changed", listener)


def test_adding_and_deleting_a_slot_announces_the_new_counters(
    seen, django_capture_on_commit_callbacks
):
    world = make_world(slots=1)
    with django_capture_on_commit_callbacks(execute=True):
        slot = parking_services.save_slot(instance=None, data={"zone": world.zone, "code": "Z-9"})
        parking_services.delete_slot(slot=slot)
    assert seen == [world.lot.pk, world.lot.pk]


def test_bulk_creating_slots_announces(seen, django_capture_on_commit_callbacks):
    world = make_world(slots=1)
    with django_capture_on_commit_callbacks(execute=True):
        parking_services.bulk_create_slots(zone=world.zone, prefix="B", start=1, end=3)
    assert seen == [world.lot.pk]


def test_reconcile_announces_only_the_lots_it_corrected(seen, django_capture_on_commit_callbacks):
    drifted, fine = make_world(slots=2), make_world(slots=2)
    ParkingLot.objects.filter(pk=drifted.lot.pk).update(free_slots=0)
    with django_capture_on_commit_callbacks(execute=True):
        result = parking_services.reconcile_counters()
    assert result.fixed == 1
    assert seen == [drifted.lot.pk] and fine.lot.pk not in seen


# --- slot codes ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("code", ["A-1", "b_22", "X", "12", "A" * 20])
def test_plain_slot_codes_are_accepted(code):
    from apps.parking.models import Zone  # noqa: F401
    from tests.adminpanel.test_slots_zones_tariffs import SLOTS

    world = make_world(slots=1)
    response = client_for(world.owner).post(
        SLOTS, {"zone": str(world.zone.pk), "code": code}, format="json"
    )
    assert response.status_code == 201, response.content


@pytest.mark.parametrize(
    "code",
    ["http://evil.example/x", "A 1", "-A", "A/1", "<b>x</b>", "A" * 21, "Новый", "A\n1", ""],
)
def test_slot_codes_that_could_carry_links_or_markup_are_refused(code):
    from tests.adminpanel.test_slots_zones_tariffs import SLOTS

    world = make_world(slots=1)
    response = client_for(world.owner).post(
        SLOTS, {"zone": str(world.zone.pk), "code": code}, format="json"
    )
    assert response.status_code == 400


# --- task wrappers and helpers (coverage) ---------------------------------------------------------


class TestNotificationTasks:
    def test_housekeeping_tasks_return_their_counts(self, enqueued):
        make_driver()
        assert tasks.prune_push_tokens.apply().get() == 0
        assert tasks.purge_notification_log.apply().get() == 0
        assert tasks.resend_pending.apply().get() == 0
        assert tasks.check_push_receipts.apply().get()["checked"] == 0

    def test_a_finished_send_returns_true(self, expo):
        user = make_driver()
        log = NotificationLog.objects.create(user=user, event="no_show", dedupe_key="x")
        assert tasks.send_notification.apply(args=(str(log.pk),)).get() is True


def test_unusable_booking_ids_give_no_links():
    assert delivery._safe(lambda v: (_ for _ in ()).throw(ValueError()), "x") is None
    assert delivery._safe(str, "") is None
