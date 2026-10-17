"""Migration 0002 must not crash on legacy rows that would violate the new CHECK constraints."""

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

from apps.core.geo import make_point

pytestmark = pytest.mark.django_db(transaction=True)

BEFORE = [("parking", "0001_initial")]
AFTER = [("parking", "0002_constraints_ordering_limits")]


@pytest.fixture
def at_0001():
    executor = MigrationExecutor(connection)
    executor.migrate(BEFORE)
    apps = MigrationExecutor(connection).loader.project_state(BEFORE).apps
    yield apps
    # a failed upgrade leaves its bad row behind; drop it so the final migrate can succeed
    apps.get_model("parking", "Tariff").objects.all().delete()
    # leave the shared test database fully migrated for whoever runs next
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())


def _legacy_lot(apps, free, total):
    user_model = apps.get_model("accounts", "User")
    lot_model = apps.get_model("parking", "ParkingLot")
    owner = user_model.objects.create(telegram_id=9_000_000 + total + free, role="OWNER")
    return lot_model.objects.create(
        owner=owner, name="L", address="A", location=make_point(69, 41),
        free_slots=free, total_slots=total,
    )  # fmt: skip


def test_inconsistent_counters_are_repaired_not_fatal(at_0001):
    lot = _legacy_lot(at_0001, free=5, total=2)  # free > total (legacy bug)
    zone = at_0001.get_model("parking", "Zone").objects.create(parking_lot=lot, name="A")
    slots = at_0001.get_model("parking", "Slot")
    slots.objects.create(zone=zone, code="A-1", status="FREE")
    slots.objects.create(zone=zone, code="A-2", status="OCCUPIED")

    MigrationExecutor(connection).migrate(AFTER)

    after = MigrationExecutor(connection).loader.project_state(AFTER).apps
    fixed = after.get_model("parking", "ParkingLot").objects.get(pk=lot.pk)
    assert (fixed.total_slots, fixed.free_slots) == (2, 1)


def test_lots_without_slots_are_zeroed(at_0001):
    lot = _legacy_lot(at_0001, free=3, total=1)
    MigrationExecutor(connection).migrate(AFTER)
    after = MigrationExecutor(connection).loader.project_state(AFTER).apps
    fixed = after.get_model("parking", "ParkingLot").objects.get(pk=lot.pk)
    assert (fixed.total_slots, fixed.free_slots) == (0, 0)


def test_negative_price_stops_the_migration_with_a_clear_message(at_0001):
    lot = _legacy_lot(at_0001, free=0, total=0)
    at_0001.get_model("parking", "Tariff").objects.create(
        parking_lot=lot, slot_type="EV", price_per_hour="-5"
    )
    with pytest.raises(RuntimeError, match="negative price"):
        MigrationExecutor(connection).migrate(AFTER)
