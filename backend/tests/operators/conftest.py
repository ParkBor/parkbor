import logging

import pytest

from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.operators.helpers import make_gate


@pytest.fixture
def gate(db):
    return make_gate()


@pytest.fixture(autouse=True)
def _audit_records_reach_caplog(monkeypatch):
    monkeypatch.setattr(logging.getLogger("habi.audit"), "propagate", True)
