"""Fixtures of the admin operations API tests: two owners with one active lot each, a driver."""

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user

BASE = "/api/v1/admin"


def bearer(user) -> APIClient:
    """A client that authenticates with a real access token (the production path)."""
    client = APIClient()
    token = RefreshToken.for_user(user).access_token
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


@pytest.fixture
def admin(db):
    return make_user("ADMIN", first_name="Ada")


@pytest.fixture
def super_admin(db):
    return make_user("ADMIN", is_superuser=True, first_name="Root")


@pytest.fixture
def driver(db):
    return make_user("DRIVER", first_name="Dilya", telegram_username="dilya", phone="+998901112233")


@pytest.fixture
def world_a(db):
    return make_world(slots=3)


@pytest.fixture
def world_b(db):
    return make_world(slots=2)


@pytest.fixture
def owner_a(world_a):
    return world_a.owner


@pytest.fixture
def owner_b(world_b):
    return world_b.owner


@pytest.fixture
def now():
    return timezone.now().replace(microsecond=0)


@pytest.fixture
def make_bk(driver, now):
    """Build a booking in a world: ``make_bk(world_a, status="CONFIRMED", hours=(2, 4))``."""

    def build(world, *, slot=0, status="CONFIRMED", hours=(2, 4), amount="12000", **extra):
        return make_booking(
            user=extra.pop("user", driver),
            slot=world.slots[slot],
            vehicle=extra.pop("vehicle", None) or make_vehicle(driver),
            start=now + timedelta(hours=hours[0]),
            end=now + timedelta(hours=hours[1]),
            status=status,
            amount=amount,
            payment_provider=extra.pop("payment_provider", "payme"),
            **extra,
        )

    return build
