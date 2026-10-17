"""Fail-closed GIS stand-in, CI postgis gate, strict OpenAPI schema, DB constraints."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from django.core.management import call_command

from apps.parking.models import ParkingLot, Tariff
from tests.postgis_gate import GateDecision, decide_postgis_gate

BACKEND = Path(__file__).resolve().parents[2]


def _run(code, settings_module, extra_env=None):
    env = {**os.environ, "DJANGO_SETTINGS_MODULE": settings_module, **(extra_env or {})}
    return subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-c", code], cwd=BACKEND, env=env, capture_output=True, text=True
    )


FAKE_NO_GDAL = (
    "import sys; sys.path.insert(0, '.');"
    "import apps.core.gis_detect as g; g.detect_gis = lambda: False;"
)


def test_geo_stub_refused_outside_dev_and_test():
    result = _run(FAKE_NO_GDAL + "import apps.core.geo", "config.settings.base")
    assert result.returncode != 0
    assert "ImproperlyConfigured" in result.stderr


def test_geo_stub_allowed_when_setting_enabled():
    result = _run(
        FAKE_NO_GDAL + "import apps.core.geo as geo; print(geo.HAS_GIS)", "config.settings.test"
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "False"


def test_dev_and_test_settings_enable_the_stub_base_does_not():
    from config.settings import base, dev, test

    assert dev.GEO_STUB is True
    assert test.GEO_STUB is True
    assert not getattr(base, "GEO_STUB", False)


class TestPostgisGate:
    def test_skips_when_unavailable_and_not_required(self):
        assert (
            decide_postgis_gate(has_gis=False, engine="sqlite3", require=False) == GateDecision.SKIP
        )

    def test_runs_when_available(self):
        assert decide_postgis_gate(has_gis=True, engine="postgis", require=True) == GateDecision.RUN

    def test_fails_when_required_but_unavailable(self):
        assert (
            decide_postgis_gate(has_gis=False, engine="postgis", require=True) == GateDecision.FAIL
        )
        assert (
            decide_postgis_gate(has_gis=True, engine="sqlite3", require=True) == GateDecision.FAIL
        )


def test_openapi_schema_has_no_warnings(tmp_path):
    out = tmp_path / "schema.yml"
    call_command("spectacular", "--file", str(out), "--fail-on-warn")
    text = out.read_text(encoding="utf-8")
    for name in ("SlotTypeEnum", "LotStatusEnum", "SlotStatusEnum"):
        assert name in text


def test_check_constraints_declared():
    lot = {c.name for c in ParkingLot._meta.constraints}
    tariff = {c.name for c in Tariff._meta.constraints}
    assert "parking_lot_free_lte_total" in lot
    assert "tariff_price_non_negative" in tariff


@pytest.mark.django_db
def test_database_rejects_free_greater_than_total():
    from django.db import IntegrityError, transaction

    from tests.helpers import make_lot, make_user

    owner = make_user("OWNER")
    with pytest.raises(IntegrityError), transaction.atomic():
        make_lot(owner, total_slots=1, free_slots=2)


@pytest.mark.django_db
def test_database_rejects_negative_price():
    from django.db import IntegrityError, transaction

    from tests.helpers import make_lot, make_user

    lot_a = make_lot(make_user("OWNER"))
    with pytest.raises(IntegrityError), transaction.atomic():
        Tariff.objects.create(parking_lot=lot_a, slot_type="EV", price_per_hour="-1")


def test_stable_ordering_filter_appends_id_tiebreaker():
    from apps.adminpanel.filters import StableOrderingFilter

    backend = StableOrderingFilter()

    class V:
        ordering_fields = ["status"]

    class R:
        query_params = {"ordering": "status"}

    assert backend.get_ordering(R(), None, V())[-1] == "id"
    R.query_params = {}
    V.ordering = ["-name"]
    assert backend.get_ordering(R(), None, V())[-1] == "id"
