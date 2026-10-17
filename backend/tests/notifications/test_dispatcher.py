"""notify(): the idempotent entry point (NotificationLog + enqueue after commit)."""

import uuid

import pytest
from django.db import transaction

from apps.notifications import dispatcher, events
from apps.notifications.models import NotificationLog
from tests.notifications.conftest import make_driver

pytestmark = pytest.mark.django_db


def test_notify_writes_a_pending_log_and_queues_the_send(
    enqueued, django_capture_on_commit_callbacks
):
    user = make_driver()
    booking_id = str(uuid.uuid4())
    with django_capture_on_commit_callbacks(execute=True):
        log = dispatcher.notify(
            user.pk, events.BOOKING_CONFIRMED, {"booking_id": booking_id}, dedupe_key=booking_id
        )
    assert log.status == NotificationLog.Status.PENDING
    assert (log.user_id, log.event, log.dedupe_key) == (user.pk, "booking_confirmed", booking_id)
    assert log.context == {"booking_id": booking_id}
    assert enqueued == [([str(log.pk)], None)]


def test_a_second_notify_for_the_same_fact_does_nothing(
    enqueued, django_capture_on_commit_callbacks
):
    user = make_driver()
    with django_capture_on_commit_callbacks(execute=True):
        first = dispatcher.notify(user.pk, events.NO_SHOW, {}, dedupe_key="b1")
        second = dispatcher.notify(user.pk, events.NO_SHOW, {}, dedupe_key="b1")
    assert first is not None and second is None
    assert NotificationLog.objects.count() == 1
    assert len(enqueued) == 1


def test_other_facts_users_and_events_are_independent(enqueued, django_capture_on_commit_callbacks):
    a, b = make_driver(), make_driver()
    with django_capture_on_commit_callbacks(execute=True):
        results = [
            dispatcher.notify(a.pk, events.NO_SHOW, {}, dedupe_key="b1"),
            dispatcher.notify(a.pk, events.NO_SHOW, {}, dedupe_key="b2"),
            dispatcher.notify(b.pk, events.NO_SHOW, {}, dedupe_key="b1"),
            dispatcher.notify(a.pk, events.BOOKING_CANCELLED, {}, dedupe_key="b1"),
        ]
    assert all(results) and NotificationLog.objects.count() == 4


def test_the_database_enforces_uniqueness_even_if_the_check_is_bypassed(enqueued):
    from django.db import IntegrityError

    user = make_driver()
    dispatcher.notify(user.pk, events.NO_SHOW, {}, dedupe_key="b1")
    with pytest.raises(IntegrityError), transaction.atomic():
        NotificationLog.objects.create(user=user, event=events.NO_SHOW, dedupe_key="b1")


def test_unknown_events_are_refused(enqueued):
    with pytest.raises(ValueError):
        dispatcher.notify(make_driver().pk, "nope", {}, dedupe_key="x")


def test_a_walk_in_without_a_user_is_skipped_silently(enqueued):
    assert dispatcher.notify(None, events.OVERSTAY_DETECTED, {}, dedupe_key="x") is None
    assert NotificationLog.objects.count() == 0


def test_only_template_values_are_kept_in_the_context(enqueued):
    user = make_driver()
    log = dispatcher.notify(
        user.pk,
        events.SLOT_REASSIGNED,
        {"booking_id": "b", "slot": "A-1", "plate": "01A123BC", "phone": "+998", "amount": 5},
        dedupe_key="x",
    )
    assert log.context == {"booking_id": "b", "slot": "A-1", "amount": "5"}


def test_a_broken_broker_does_not_break_the_caller(monkeypatch, django_capture_on_commit_callbacks):
    from apps.notifications import tasks

    def boom(*a, **k):
        raise OSError("broker down")

    monkeypatch.setattr(tasks.send_notification, "apply_async", boom)
    user = make_driver()
    with django_capture_on_commit_callbacks(execute=True):
        log = dispatcher.notify(user.pk, events.NO_SHOW, {}, dedupe_key="x")
    log.refresh_from_db()
    assert log.status == NotificationLog.Status.PENDING  # resend_pending will pick it up


def test_nothing_is_queued_when_the_surrounding_transaction_rolls_back(
    enqueued, django_capture_on_commit_callbacks
):
    user = make_driver()
    with django_capture_on_commit_callbacks(execute=True):
        try:
            with transaction.atomic():
                dispatcher.notify(user.pk, events.NO_SHOW, {}, dedupe_key="x")
                raise RuntimeError("rollback")
        except RuntimeError:
            pass
    assert enqueued == [] and NotificationLog.objects.count() == 0
