"""deliver(): channel choice, language, deep links, failures, retries, idempotency."""

import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Device, User
from apps.notifications import delivery, events
from apps.notifications.channels.expo_push import PushOutcome, PushResult
from apps.notifications.channels.telegram import TelegramOutcome, TelegramResult
from apps.notifications.models import NotificationLog
from tests.notifications.conftest import TOKEN, TOKEN_2, make_driver

pytestmark = pytest.mark.django_db
Status = NotificationLog.Status


def make_log(user, event=events.BOOKING_CONFIRMED, **context):
    booking_id = context.pop("booking_id", str(uuid.uuid4()))
    return NotificationLog.objects.create(
        user=user,
        event=event,
        dedupe_key=booking_id,
        context={"booking_id": booking_id, **context},
    )


def fresh(log):
    log.refresh_from_db()
    return log


# --- channel choice -----------------------------------------------------------------------


def test_push_is_used_when_the_user_has_a_device(expo, tg):
    user = make_driver(devices=[TOKEN])
    log = make_log(user)
    result = delivery.deliver(log.pk)
    assert result.retry_in is None
    assert len(expo.messages) == 1 and tg.sent == []
    log = fresh(log)
    assert (log.status, log.channel, log.delivered, log.attempts) == (
        Status.SENT,
        "push",
        "push",
        1,
    )
    assert log.sent_at is not None and log.last_error == ""


def test_push_goes_to_every_device_of_the_user(expo):
    user = make_driver(devices=[TOKEN, TOKEN_2])
    delivery.deliver(make_log(user).pk)
    assert {m.token for m in expo.messages} == {TOKEN, TOKEN_2}


def test_push_carries_the_deep_link_and_no_personal_data(expo):
    user = make_driver(devices=[TOKEN])
    log = make_log(user)
    delivery.deliver(log.pk)
    [message] = expo.messages
    assert message.data["url"] == f"parkbor://booking/{log.context['booking_id']}"
    assert message.data["event"] == "booking_confirmed"
    text = (message.title + message.body + str(message.data)).lower()
    assert str(user.telegram_id) not in text and "01a" not in text


def test_telegram_is_the_fallback_when_there_is_no_device(expo, tg):
    user = make_driver(telegram_on=True)
    log = make_log(user)
    delivery.deliver(log.pk)
    assert expo.calls == []
    [sent] = tg.sent
    assert sent["chat_id"] == user.telegram_id
    assert sent["url"] == f"https://parkbor.test/b/{log.context['booking_id']}"
    assert sent["label"] == "Bronni ochish"
    assert fresh(log).channel == "telegram"


def test_a_non_critical_event_uses_push_only_when_both_are_enabled(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    delivery.deliver(make_log(user, events.BOOKING_CONFIRMED).pk)
    assert len(expo.messages) == 1 and tg.sent == []


@pytest.mark.parametrize("event", sorted(events.CRITICAL_EVENTS))
def test_a_critical_event_goes_to_both_channels(expo, tg, event):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    log = make_log(user, event, amount="5000")
    delivery.deliver(log.pk)
    assert len(expo.messages) == 1 and len(tg.sent) == 1
    assert (fresh(log).channel, fresh(log).delivered) == ("push+telegram", "push+telegram")


def test_telegram_is_never_used_when_the_user_turned_it_off(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=False)
    delivery.deliver(make_log(user, events.OVERSTAY_DETECTED).pk)
    assert tg.sent == []


def test_no_channel_at_all_is_skipped(expo, tg):
    log = make_log(make_driver())
    result = delivery.deliver(log.pk)
    assert result.retry_in is None
    log = fresh(log)
    assert (log.status, log.last_error) == (Status.SKIPPED, "no_channel")
    assert expo.calls == [] and tg.sent == []


def test_an_inactive_user_gets_nothing(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    User.objects.filter(pk=user.pk).update(is_active=False)
    log = make_log(user)
    delivery.deliver(log.pk)
    assert fresh(log).last_error == "user_inactive" and expo.calls == [] and tg.sent == []


# --- language -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("language", "title"),
    [("uz", "Bron tasdiqlandi"), ("ru", "Бронь подтверждена"), ("en", "Booking confirmed")],
)
def test_the_message_is_in_the_users_language(expo, language, title):
    user = make_driver(devices=[TOKEN], language=language)
    delivery.deliver(make_log(user).pk)
    assert expo.messages[0].title == title


def test_telegram_text_is_title_and_body(tg):
    user = make_driver(telegram_on=True, language="en")
    delivery.deliver(make_log(user).pk)
    assert tg.sent[0]["text"].startswith("Booking confirmed\n")
    assert tg.sent[0]["label"] == "Open booking"


def test_a_slot_code_and_amount_reach_the_text(expo):
    user = make_driver(devices=[TOKEN], language="en")
    delivery.deliver(make_log(user, events.SLOT_REASSIGNED, slot="B-7").pk)
    assert "B-7" in expo.messages[0].body
    delivery.deliver(make_log(user, events.REFUND_DONE, amount="12500.00").pk)
    assert "12 500" in expo.messages[1].body


def test_no_button_without_a_booking_or_a_public_url(tg, settings):
    user = make_driver(telegram_on=True)
    settings.HABI_PUBLIC_URL = ""
    delivery.deliver(make_log(user).pk)
    assert tg.sent[0]["url"] is None


# --- push failures ------------------------------------------------------------------------


def test_an_unregistered_device_is_deleted_and_telegram_takes_over(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    expo.script = [PushResult(PushOutcome.INVALID_TOKEN, "DeviceNotRegistered")]
    log = make_log(user)
    delivery.deliver(log.pk)
    assert not Device.objects.filter(user=user).exists()
    assert len(tg.sent) == 1 and fresh(log).status == Status.SENT


def test_only_the_dead_token_is_deleted(expo):
    user = make_driver(devices=[TOKEN, TOKEN_2])
    expo.by_token = {TOKEN: PushResult(PushOutcome.INVALID_TOKEN, "DeviceNotRegistered")}
    log = make_log(user)
    delivery.deliver(log.pk)
    tokens = Device.objects.filter(user=user).values_list("expo_push_token", flat=True)
    assert list(tokens) == [TOKEN_2]
    assert fresh(log).status == Status.SENT


def test_a_dead_device_and_no_telegram_is_skipped(expo):
    user = make_driver(devices=[TOKEN])
    expo.script = [PushResult(PushOutcome.INVALID_TOKEN, "DeviceNotRegistered")]
    log = make_log(user)
    delivery.deliver(log.pk)
    assert (fresh(log).status, fresh(log).last_error) == (Status.SKIPPED, "no_channel")


def test_a_transient_push_failure_is_retried_with_backoff(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    expo.script = [PushResult(PushOutcome.RETRY, "MessageRateExceeded")]
    log = make_log(user)
    result = delivery.deliver(log.pk)
    log = fresh(log)
    assert (log.status, log.attempts, log.last_error) == (Status.PENDING, 1, "MessageRateExceeded")
    assert result.retry_in == 30
    assert tg.sent == []  # still hoping for push
    # the next attempt succeeds
    assert delivery.deliver(log.pk).retry_in is None
    assert fresh(log).status == Status.SENT and fresh(log).attempts == 2


def test_backoff_is_exponential_and_capped(expo):
    user = make_driver(devices=[TOKEN])
    expo.script = [PushResult(PushOutcome.RETRY, "x")] * 4
    log = make_log(user)
    waits = [delivery.deliver(log.pk).retry_in for _ in range(4)]
    assert waits == [30, 60, 120, 240]


def test_retry_after_from_expo_is_respected(expo):
    user = make_driver(devices=[TOKEN])
    expo.script = [PushResult(PushOutcome.RETRY, "http_429", retry_after=77)]
    assert delivery.deliver(make_log(user).pk).retry_in == 77


def test_the_last_attempt_falls_back_to_telegram(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    expo.script = [PushResult(PushOutcome.RETRY, "x")] * 5
    log = make_log(user)
    for _ in range(4):
        assert delivery.deliver(log.pk).retry_in is not None
    assert delivery.deliver(log.pk).retry_in is None
    assert len(tg.sent) == 1 and fresh(log).status == Status.SENT


def test_giving_up_after_five_attempts_marks_it_failed(expo):
    user = make_driver(devices=[TOKEN])
    expo.script = [PushResult(PushOutcome.RETRY, "MessageRateExceeded")] * 5
    log = make_log(user)
    for _ in range(5):
        delivery.deliver(log.pk)
    log = fresh(log)
    assert (log.status, log.attempts, log.last_error) == (
        Status.FAILED,
        5,
        "MessageRateExceeded",
    )
    assert delivery.deliver(log.pk).retry_in is None  # nothing more happens


def test_a_permanent_push_failure_is_failed_at_once(expo):
    user = make_driver(devices=[TOKEN])
    expo.script = [PushResult(PushOutcome.FAILED, "MessageTooBig")]
    log = make_log(user)
    delivery.deliver(log.pk)
    assert (fresh(log).status, fresh(log).last_error) == (Status.FAILED, "MessageTooBig")


def test_an_unexpected_exception_from_the_push_client_is_a_retry(expo):
    user = make_driver(devices=[TOKEN])
    expo.script = [RuntimeError("boom with ExponentPushToken[device-one]")]
    log = make_log(user)
    result = delivery.deliver(log.pk)
    assert result.retry_in == 30
    assert fresh(log).last_error == "push_error"


# --- telegram failures ------------------------------------------------------------------------


def test_a_user_who_blocked_the_bot_is_switched_off_and_skipped(tg):
    user = make_driver(telegram_on=True)
    tg.script = [TelegramOutcome.BLOCKED]
    log = make_log(user)
    delivery.deliver(log.pk)
    user.refresh_from_db()
    assert user.tg_notifications is False
    assert (fresh(log).status, fresh(log).last_error) == (Status.SKIPPED, "telegram_blocked")


def test_a_blocked_bot_does_not_hide_a_delivered_push(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    tg.script = [TelegramOutcome.BLOCKED]
    log = make_log(user, events.OVERSTAY_DETECTED)
    delivery.deliver(log.pk)
    user.refresh_from_db()
    assert user.tg_notifications is False
    assert (fresh(log).status, fresh(log).delivered) == (Status.SENT, "push")


def test_telegram_rate_limit_waits_for_retry_after(tg):
    user = make_driver(telegram_on=True)
    tg.script = [TelegramResult(TelegramOutcome.RETRY, "telegram_429", retry_after=17)]
    log = make_log(user)
    result = delivery.deliver(log.pk)
    assert result.retry_in == 17
    assert (fresh(log).status, fresh(log).last_error) == (Status.PENDING, "telegram_429")


def test_a_critical_event_retries_only_the_channel_that_failed(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    tg.script = [TelegramResult(TelegramOutcome.RETRY, "telegram_429", retry_after=5)]
    log = make_log(user, events.OVERSTAY_DETECTED)
    assert delivery.deliver(log.pk).retry_in == 5
    assert fresh(log).delivered == "push"
    assert delivery.deliver(log.pk).retry_in is None
    assert len(expo.messages) == 1  # push was not sent again
    assert len(tg.sent) == 2
    assert (fresh(log).status, fresh(log).delivered) == (Status.SENT, "push+telegram")


def test_a_permanent_telegram_failure_is_failed(tg):
    user = make_driver(telegram_on=True)
    tg.script = [TelegramResult(TelegramOutcome.FAILED, "telegram_400")]
    log = make_log(user)
    delivery.deliver(log.pk)
    assert (fresh(log).status, fresh(log).last_error) == (Status.FAILED, "telegram_400")


# --- idempotency ----------------------------------------------------------------------------


def test_a_sent_notification_is_never_sent_again(expo):
    user = make_driver(devices=[TOKEN])
    log = make_log(user)
    delivery.deliver(log.pk)
    result = delivery.deliver(log.pk)
    assert result.retry_in is None
    assert len(expo.calls) == 1 and fresh(log).attempts == 1


@pytest.mark.parametrize("status", [Status.SKIPPED, Status.FAILED])
def test_finished_logs_are_left_alone(expo, status):
    user = make_driver(devices=[TOKEN])
    log = make_log(user)
    NotificationLog.objects.filter(pk=log.pk).update(status=status)
    delivery.deliver(log.pk)
    assert expo.calls == []


def test_a_row_claimed_by_another_worker_is_not_sent_twice(expo):
    user = make_driver(devices=[TOKEN])
    log = make_log(user)
    NotificationLog.objects.filter(pk=log.pk).update(
        lease_until=timezone.now() + timedelta(seconds=60)
    )
    delivery.deliver(log.pk)
    assert expo.calls == []


def test_an_expired_lease_can_be_reclaimed(expo):
    user = make_driver(devices=[TOKEN])
    log = make_log(user)
    NotificationLog.objects.filter(pk=log.pk).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    delivery.deliver(log.pk)
    assert len(expo.calls) == 1


def test_a_missing_log_is_ignored():
    assert delivery.deliver(uuid.uuid4()).retry_in is None


def test_the_lease_is_released_after_an_attempt(expo):
    user = make_driver(devices=[TOKEN])
    expo.script = [PushResult(PushOutcome.RETRY, "x")]
    log = make_log(user)
    delivery.deliver(log.pk)
    assert fresh(log).lease_until is None


def test_errors_never_contain_tokens_or_chat_ids(expo, tg):
    user = make_driver(devices=[TOKEN], telegram_on=True)
    expo.script = [PushResult(PushOutcome.RETRY, "http_500")]
    log = make_log(user)
    delivery.deliver(log.pk)
    error = fresh(log).last_error
    assert error == "http_500"
    assert TOKEN not in error and str(user.telegram_id) not in error


def test_push_data_holds_only_event_url_and_booking_id(expo):
    user = make_driver(devices=[TOKEN])
    log = make_log(user, events.SLOT_REASSIGNED, slot="B-7", plate="01A777BC", phone="+998901")
    delivery.deliver(log.pk)
    [message] = expo.messages
    assert set(message.data) == {"event", "url", "booking_id"}
    assert message.data["url"] == f"parkbor://booking/{log.context['booking_id']}"
    assert "01A777BC" not in repr(message) and "+998" not in repr(message)
