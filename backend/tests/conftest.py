import os

import pytest

from apps.core.geo import HAS_GIS
from tests.postgis_gate import GateDecision, decide_postgis_gate


def pytest_collection_modifyitems(config, items):
    """postgis-marked tests: run, skip, or (REQUIRE_POSTGIS=1, CI) fail the build."""
    from django.conf import settings

    decision = decide_postgis_gate(
        has_gis=HAS_GIS,
        engine=settings.DATABASES["default"]["ENGINE"],
        require=os.environ.get("REQUIRE_POSTGIS") == "1",
    )
    marked = [item for item in items if "postgis" in item.keywords]
    if decision is GateDecision.FAIL and marked:
        raise pytest.UsageError(
            "REQUIRE_POSTGIS=1 but GDAL/PostGIS is unavailable: postgis tests cannot run."
        )
    if decision is GateDecision.SKIP:
        skip = pytest.mark.skip(reason="needs GDAL/GEOS and a PostGIS database")
        for item in marked:
            item.add_marker(skip)
    _gate_redis(items)


def _gate_redis(items) -> None:
    """redis-marked tests need a real Redis: skipped without REDIS_TEST_URL, a build failure when
    REQUIRE_REDIS=1 (CI) says it must be there."""
    marked = [item for item in items if "redis" in item.keywords]
    if os.environ.get("REDIS_TEST_URL") or not marked:
        return
    if os.environ.get("REQUIRE_REDIS") == "1":
        raise pytest.UsageError("REQUIRE_REDIS=1 but REDIS_TEST_URL is not set.")
    skip = pytest.mark.skip(reason="needs a real Redis (set REDIS_TEST_URL)")
    for item in marked:
        item.add_marker(skip)


@pytest.fixture(autouse=True, scope="session")
def _sqlite_without_gist():
    """On SQLite (no-GDAL dev boxes) create GiST indexes as plain indexes so tables build."""
    from django.conf import settings
    from django.db.models import Index

    if "sqlite" not in settings.DATABASES["default"]["ENGINE"]:
        yield
        return
    from django.contrib.postgres.indexes import GistIndex

    original = GistIndex.create_sql
    GistIndex.create_sql = lambda self, model, schema_editor, using="", **kw: Index.create_sql(
        self, model, schema_editor, using="", **kw
    )
    try:
        yield
    finally:
        GistIndex.create_sql = original
