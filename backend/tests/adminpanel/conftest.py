import logging

import pytest

from apps.parking.models import Slot, Tariff, Zone
from tests.helpers import make_lot, make_user


@pytest.fixture(autouse=True)
def _audit_records_reach_caplog(monkeypatch):
    """habi.audit does not propagate in production (own handler); let caplog see it in tests."""
    monkeypatch.setattr(logging.getLogger("habi.audit"), "propagate", True)


@pytest.fixture
def admin_user(db):
    return make_user("ADMIN")


@pytest.fixture
def owner_a(db):
    return make_user("OWNER")


@pytest.fixture
def owner_b(db):
    return make_user("OWNER")


@pytest.fixture
def driver(db):
    return make_user("DRIVER")


@pytest.fixture
def lot_a(owner_a):
    return make_lot(owner_a, "Lot A")


@pytest.fixture
def lot_b(owner_b):
    return make_lot(owner_b, "Lot B")


@pytest.fixture
def zone_a(lot_a):
    return Zone.objects.create(parking_lot=lot_a, name="A")


@pytest.fixture
def zone_b(lot_b):
    return Zone.objects.create(parking_lot=lot_b, name="A")


@pytest.fixture
def slot_a(zone_a):
    return Slot.objects.create(zone=zone_a, code="A-1")


@pytest.fixture
def slot_b(zone_b):
    return Slot.objects.create(zone=zone_b, code="A-1")


@pytest.fixture
def tariff_b(lot_b):
    return Tariff.objects.create(parking_lot=lot_b, slot_type="STANDARD", price_per_hour="5000")
