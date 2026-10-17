from datetime import timedelta

import pytest
from django.utils import timezone

from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user
from tests.payments.factories import FakeTransport


@pytest.fixture
def driver(db):
    return make_user("DRIVER")


@pytest.fixture
def vehicle(driver):
    return make_vehicle(driver)


@pytest.fixture
def world(db):
    return make_world(slots=3)


@pytest.fixture
def now():
    return timezone.now().replace(microsecond=0)


@pytest.fixture
def booking(driver, vehicle, world, now):
    """A fresh unpaid booking: 12 000 so'm, hold ends in 10 minutes, Payme chosen."""
    return make_booking(
        user=driver,
        slot=world.slots[0],
        vehicle=vehicle,
        start=now + timedelta(hours=2),
        end=now + timedelta(hours=4),
        hold_expires_at=now + timedelta(minutes=10),
        payment_provider="payme",
    )


@pytest.fixture
def make_pending(driver, world, now):
    """Factory for more unpaid bookings (own vehicle and slot each)."""
    counter = {"n": 0}

    def build(**extra):
        counter["n"] += 1
        slot = world.slots[min(counter["n"], 2)]
        return make_booking(
            user=driver,
            slot=slot,
            vehicle=make_vehicle(driver),
            start=now + timedelta(hours=6 + counter["n"] * 3),
            end=now + timedelta(hours=8 + counter["n"] * 3),
            hold_expires_at=extra.pop("hold_expires_at", now + timedelta(minutes=10)),
            payment_provider=extra.pop("payment_provider", "payme"),
            **extra,
        )

    return build


@pytest.fixture
def transport():
    """A fake HTTP transport: no refund test ever reaches the network."""
    from apps.payments.providers import http

    fake = FakeTransport()
    http.set_transport(fake)
    yield fake
    http.set_transport(None)
