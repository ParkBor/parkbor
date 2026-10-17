"""Celery wiring: tasks delegate to services; beat schedule is complete."""

from datetime import timedelta

import pytest

from apps.bookings import tasks
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from config.celery import CELERY_BEAT_SCHEDULE, app
from tests.bookings.factories import make_booking

pytestmark = pytest.mark.django_db


def test_beat_schedule_runs_every_minute():
    booking_jobs = {
        k: e for k, e in CELERY_BEAT_SCHEDULE.items() if e["task"].startswith("bookings.")
    }
    assert {e["task"] for e in booking_jobs.values()} == {
        "bookings.mark_no_shows",
        "bookings.detect_overstays",
        "bookings.expire_overdue_holds",
    }
    assert all(e["schedule"] == 60.0 for e in booking_jobs.values())
    assert CELERY_BEAT_SCHEDULE["parking-reconcile-free-slots"]["schedule"] == 300.0
    assert app.conf.beat_schedule == CELERY_BEAT_SCHEDULE


def test_every_scheduled_task_is_registered():
    app.finalize()
    app.loader.import_default_modules()  # autodiscovery is lazy: do not depend on test order
    for entry in CELERY_BEAT_SCHEDULE.values():
        assert entry["task"] in app.tasks


def test_expire_hold_task_expires_and_is_idempotent(driver, vehicle, world, now):
    booking = make_booking(
        user=driver,
        slot=world.slots[0],
        vehicle=vehicle,
        start=now + timedelta(hours=1),
        end=now + timedelta(hours=2),
        hold_expires_at=now - timedelta(minutes=1),
    )
    assert tasks.expire_hold.apply(args=(str(booking.pk),)).get() is True
    assert tasks.expire_hold.apply(args=(str(booking.pk),)).get() is False
    assert Booking.objects.get(pk=booking.pk).status == S.EXPIRED


def test_sweep_tasks_return_counts(driver, vehicle, world, now):
    make_booking(
        user=driver,
        slot=world.slots[0],
        vehicle=vehicle,
        start=now - timedelta(hours=1),
        end=now + timedelta(hours=1),
        status=S.CONFIRMED,
    )
    make_booking(
        user=driver,
        slot=world.slots[1],
        vehicle=vehicle,
        start=now - timedelta(hours=3),
        end=now - timedelta(hours=1),
        status=S.ACTIVE,
    )
    assert tasks.mark_no_shows.apply().get() == 1
    assert tasks.detect_overstays.apply().get() == 1
    assert tasks.expire_overdue_holds.apply().get() == 0
