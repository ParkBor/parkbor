from datetime import timedelta

import pytest
from django.utils import timezone

from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.bookings.factories import make_vehicle, make_world
from tests.helpers import client_for, make_user


@pytest.fixture
def driver(db):
    return make_user("DRIVER")


@pytest.fixture
def other_driver(db):
    return make_user("DRIVER")


@pytest.fixture
def vehicle(driver):
    return make_vehicle(driver)


@pytest.fixture
def world(db):
    return make_world(slots=3)


@pytest.fixture
def api(driver):
    return client_for(driver)


@pytest.fixture
def now():
    """A whole-minute 'now' so stored periods compare exactly."""
    return timezone.now().replace(second=0, microsecond=0)


@pytest.fixture
def window(now):
    """A valid booking window: starts in one hour, lasts two."""
    return now + timedelta(hours=1), now + timedelta(hours=3)
