"""Fixtures for /parkings/nearby tests: fake Redis, no real OSRM, helpers to build lots."""

import pytest

from apps.core.geo import make_point
from apps.parking.models import LotStatus, ParkingLot, Slot, SlotStatus, SlotType, Tariff, Zone
from apps.parking.services import recalculate_counters
from apps.routing import osrm_client
from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.helpers import make_user

# A point in central Tashkent used as the "driver" position in most tests.
ORIGIN = (41.3113, 69.2743)  # (lat, lng); centre of geohash cell tx3702


def lat_offset(metres: float) -> float:
    """Degrees of latitude per metre (good enough to place test lots on a meridian)."""
    return metres / 111_194.93


@pytest.fixture(autouse=True)
def no_real_osrm(monkeypatch):
    """Default: OSRM is down (fail-soft path). Tests opt in to a working fake via `osrm`."""

    def down(*args, **kwargs):
        raise osrm_client.OsrmError("test: OSRM unavailable")

    monkeypatch.setattr(osrm_client, "table", down)


@pytest.fixture
def osrm(monkeypatch):
    """Working OSRM fake: records calls; duration (s) = straight distance / 10 by default."""
    from apps.core.geomath import haversine_m

    class Fake:
        calls = []
        durations = None  # override with a list to force exact values

        def __call__(self, origin, destinations, **kwargs):
            self.calls.append((origin, list(destinations)))
            if self.durations is not None:
                return list(self.durations)
            return [haversine_m(*origin, *d) / 10 for d in destinations]

    fake = Fake()
    fake.calls = []
    monkeypatch.setattr(osrm_client, "table", fake)
    return fake


@pytest.fixture
def owner(db):
    return make_user("OWNER")


@pytest.fixture
def driver(db):
    return make_user("DRIVER")


@pytest.fixture
def make_nearby_lot(owner):
    """Factory: lot `metres` north of ORIGIN with the given counters/price/rating."""

    def factory(
        name,
        metres=500,
        *,
        free=5,
        total=10,
        price="10000",
        rating=0.0,
        status=LotStatus.ACTIVE,
        open_time=None,
        close_time=None,
        east_metres=0,
    ):
        lat = ORIGIN[0] + lat_offset(metres)
        lng = ORIGIN[1] + east_metres / (111_194.93 * 0.7501)  # cos(41.31 deg) ~ 0.7501
        lot = ParkingLot.objects.create(
            owner=owner,
            name=name,
            address=f"{name} street",
            location=make_point(lng, lat),
            status=status,
            free_slots=free,
            total_slots=total,
            rating=rating,
            open_time=open_time,
            close_time=close_time,
        )
        if price is not None:
            Tariff.objects.create(
                parking_lot=lot, slot_type=SlotType.STANDARD, price_per_hour=price
            )
        return lot

    return factory


@pytest.fixture
def add_slots():
    """Factory: add `count` slots of a type/status to a lot, then recompute counters."""

    def factory(lot, slot_type, count, status=SlotStatus.FREE, price=None):
        zone, _ = Zone.objects.get_or_create(parking_lot=lot, name="Z")
        start = Slot.objects.filter(zone=zone).count()
        for i in range(count):
            Slot.objects.create(
                zone=zone, code=f"{slot_type[0]}-{start + i}", type=slot_type, status=status
            )
        if price is not None:
            Tariff.objects.update_or_create(
                parking_lot=lot, slot_type=slot_type, defaults={"price_per_hour": price}
            )
        recalculate_counters(lot)
        lot.refresh_from_db()
        return lot

    return factory
