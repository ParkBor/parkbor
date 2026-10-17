import pytest
from django.utils import timezone

from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401


@pytest.fixture
def now():
    return timezone.now().replace(second=0, microsecond=0)
