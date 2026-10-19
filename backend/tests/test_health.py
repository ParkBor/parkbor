import pytest
from django.test import Client

from config import health
from tests.auth_fixtures import fake_redis  # noqa: F401


@pytest.fixture(autouse=True)
def _fresh_readiness_cache():
    health.reset_readiness_cache()
    yield
    health.reset_readiness_cache()


@pytest.mark.django_db
def test_health_is_ok_without_authentication():
    response = Client().get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"database": "ok", "redis": "ok"}}
    assert response["Cache-Control"] == "no-store"


@pytest.mark.parametrize("broken", ["database", "redis"], ids=["db", "state-store"])
@pytest.mark.django_db
def test_a_failing_dependency_is_503(monkeypatch, broken):
    monkeypatch.setattr(health, f"check_{broken}", lambda: False)
    response = Client().get("/health")
    body = response.json()
    assert response.status_code == 503 and body["status"] == "unavailable"
    assert body["checks"][broken] == "fail"
    assert set(body) == {"status", "checks"}


def test_state_store_errors_are_swallowed_and_not_leaked(monkeypatch):
    class Dead:
        def ping(self):
            raise ConnectionError("redis://user:secret@host:6379 refused")

    monkeypatch.setattr(health, "get_redis", lambda: Dead())
    assert health.check_redis() is False


@pytest.mark.django_db
def test_database_errors_are_swallowed(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("down")

    monkeypatch.setattr(health.transaction, "atomic", boom)
    assert health.check_database() is False


@pytest.mark.django_db
def test_only_get_is_allowed():
    assert Client().post("/health").status_code == 405


@pytest.mark.django_db
def test_readiness_is_cached_so_a_flood_costs_one_check(monkeypatch):
    calls = []
    monkeypatch.setattr(health, "check_database", lambda: calls.append("db") or True)
    monkeypatch.setattr(health, "check_redis", lambda: calls.append("redis") or True)
    for _ in range(20):
        assert Client().get("/health").status_code == 200
    assert calls == ["db", "redis"]


@pytest.mark.django_db
def test_readiness_cache_expires(monkeypatch):
    calls = []
    monkeypatch.setattr(health, "check_database", lambda: calls.append(1) or True)
    monkeypatch.setattr(health, "check_redis", lambda: True)
    clock = iter([100.0, 104.0])
    monkeypatch.setattr(health.time, "monotonic", lambda: next(clock))
    Client().get("/health")
    Client().get("/health")
    assert len(calls) == 2


def test_liveness_does_no_io(monkeypatch):
    def boom():
        raise AssertionError("liveness must not touch dependencies")

    monkeypatch.setattr(health, "check_database", boom)
    monkeypatch.setattr(health, "check_redis", boom)
    response = Client().get("/health/live")  # no db fixture: a query would fail loudly
    assert response.status_code == 200 and response.json() == {"status": "ok"}
    assert response["Cache-Control"] == "no-store"


def test_prod_exempts_probes_from_the_https_redirect():
    import re
    from pathlib import Path

    source = (Path(health.__file__).parent / "settings" / "prod.py").read_text(encoding="utf-8")
    match = re.search(r"SECURE_REDIRECT_EXEMPT = \[r\"(.+?)\"\]", source)
    assert match
    assert re.match(match.group(1), "health") and re.match(match.group(1), "health/live")
    assert not re.match(match.group(1), "api/v1/me")
