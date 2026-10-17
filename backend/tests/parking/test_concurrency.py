"""Real parallelism against PostGIS (row locks are no-ops on SQLite, so these are CI-only)."""

import threading

import pytest
from django.db import connection

from apps.parking import services
from apps.parking.models import LotStatus, ParkingLot, Slot, Zone
from tests.helpers import make_lot, make_user

pytestmark = [pytest.mark.postgis, pytest.mark.django_db(transaction=True)]

THREADS = 6
PER_THREAD = 15


def _run_parallel(targets):
    errors: list[BaseException] = []
    barrier = threading.Barrier(len(targets))

    def wrap(target):
        def run():
            try:
                barrier.wait(timeout=10)
                target()
            except BaseException as exc:  # noqa: BLE001 - surfaced by the assertion below
                errors.append(exc)
            finally:
                connection.close()

        return run

    threads = [threading.Thread(target=wrap(t)) for t in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert not errors, errors


def test_parallel_slot_writes_keep_lot_counters_exact():
    owner = make_user("OWNER")
    lot = make_lot(owner)
    zones = [Zone.objects.create(parking_lot=lot, name=f"Z{i}") for i in range(THREADS)]

    def worker(zone):
        def run():
            for n in range(PER_THREAD):
                services.save_slot(instance=None, data={"zone": zone, "code": f"S-{n}"})

        return run

    _run_parallel([worker(zone) for zone in zones])

    lot.refresh_from_db()
    assert Slot.objects.filter(zone__parking_lot=lot).count() == THREADS * PER_THREAD
    assert (lot.total_slots, lot.free_slots) == (THREADS * PER_THREAD, THREADS * PER_THREAD)


def test_parallel_bulk_and_delete_keep_counters_exact():
    owner = make_user("OWNER")
    lot = make_lot(owner)
    zones = [Zone.objects.create(parking_lot=lot, name=f"B{i}") for i in range(4)]
    _run_parallel(
        [
            lambda zone=zone: services.bulk_create_slots(zone=zone, prefix="B", start=1, end=25)
            for zone in zones
        ]
    )
    victim = Slot.objects.filter(zone__parking_lot=lot).first()
    _run_parallel(
        [
            lambda: services.delete_slot(slot=victim),
            lambda: services.bulk_create_slots(zone=zones[0], prefix="C", start=1, end=10),
        ]
    )
    lot.refresh_from_db()
    real = Slot.objects.filter(zone__parking_lot=lot).count()
    assert (lot.total_slots, lot.free_slots) == (real, real)


def test_approval_survives_a_parallel_owner_patch():
    owner = make_user("OWNER")
    admin = make_user("ADMIN")
    lot = make_lot(owner)
    stale = ParkingLot.objects.get(pk=lot.pk)

    _run_parallel(
        [
            lambda: services.change_lot_status(lot=lot, actor=admin, action="approve"),
            lambda: services.update_lot(lot=stale, data={"open_time": None}, actor=owner),
        ]
    )

    lot.refresh_from_db()
    assert lot.status == LotStatus.ACTIVE
