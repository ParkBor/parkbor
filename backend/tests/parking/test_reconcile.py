"""reconcile_free_slots (ARCHITECTURE 16): drifted denormalised counters are repaired."""

from unittest import mock

import pytest

from apps.parking import services, tasks
from apps.parking.models import ParkingLot, Slot, SlotStatus, Zone
from config.celery import CELERY_BEAT_SCHEDULE
from tests.helpers import make_lot, make_user

pytestmark = pytest.mark.django_db


def lot_with_slots(owner, free=3, occupied=2):
    lot = make_lot(owner)
    zone = Zone.objects.create(parking_lot=lot, name="A")
    for n in range(free + occupied):
        Slot.objects.create(
            zone=zone,
            code=f"A-{n}",
            status=SlotStatus.FREE if n < free else SlotStatus.OCCUPIED,
        )
    return lot


def drift(lot, total, free):
    ParkingLot.objects.filter(pk=lot.pk).update(total_slots=total, free_slots=free)


def counters(lot):
    lot.refresh_from_db()
    return lot.total_slots, lot.free_slots


def test_drifted_counters_are_corrected():
    lot = lot_with_slots(make_user("OWNER"))
    drift(lot, 99, 0)
    result = services.reconcile_counters()
    assert counters(lot) == (5, 3)
    assert (result.checked, result.fixed, result.failed) == (1, 1, 0)


def test_correct_counters_are_left_alone():
    lot = lot_with_slots(make_user("OWNER"))
    services.recalculate_counters(lot)
    result = services.reconcile_counters()
    assert (result.checked, result.fixed) == (1, 0)


def test_every_lot_is_checked_and_each_gets_its_own_lock():
    owner = make_user("OWNER")
    lots = [lot_with_slots(owner, free=n + 1, occupied=1) for n in range(3)]
    for lot in lots:
        drift(lot, 0, 0)
    locked = []
    real = services._lock_lot
    with mock.patch.object(services, "_lock_lot", lambda i: (locked.append(i), real(i))[1]):
        result = services.reconcile_counters()
    assert result.fixed == 3
    assert sorted(locked) == sorted(lot.pk for lot in lots)
    assert [counters(lot) for lot in lots] == [(2, 1), (3, 2), (4, 3)]


def test_a_failing_lot_does_not_stop_the_others(caplog):
    owner = make_user("OWNER")
    bad, good = lot_with_slots(owner), lot_with_slots(owner)
    drift(bad, 0, 0)
    drift(good, 0, 0)
    real = services.recalculate_counters

    def flaky(lot):
        if lot.pk == bad.pk:
            raise RuntimeError("boom")
        return real(lot)

    with mock.patch.object(services, "recalculate_counters", flaky):
        result = services.reconcile_counters()
    assert (result.fixed, result.failed) == (1, 1)
    assert counters(good) == (5, 3)
    assert counters(bad) == (0, 0)  # untouched, retried in 5 minutes
    assert str(bad.pk) in caplog.text


def test_the_limit_bounds_one_run():
    owner = make_user("OWNER")
    for _ in range(3):
        drift(lot_with_slots(owner), 0, 0)
    assert services.reconcile_counters(limit=2).checked == 2


def test_the_celery_task_returns_the_number_of_repaired_lots():
    lot = lot_with_slots(make_user("OWNER"))
    drift(lot, 1, 1)
    assert tasks.reconcile_free_slots.apply().get() == 1
    assert tasks.reconcile_free_slots.apply().get() == 0


def test_it_is_scheduled_every_five_minutes():
    entry = CELERY_BEAT_SCHEDULE["parking-reconcile-free-slots"]
    assert entry["task"] == "parking.reconcile_free_slots"
    assert entry["schedule"] == 300.0
