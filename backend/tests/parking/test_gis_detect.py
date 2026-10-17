import logging
import os
import subprocess
import sys
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

from apps.core import gis_detect

BACKEND = Path(__file__).resolve().parents[2]


def test_failure_reason_is_recorded_and_logged(monkeypatch, caplog):
    def boom(name):
        raise ImproperlyConfigured("Could not find the GDAL library (libgdal-xyz)")

    monkeypatch.setattr(gis_detect, "_import", boom)
    with caplog.at_level(logging.WARNING, logger="apps.core.gis_detect"):
        assert gis_detect.detect_gis() is False
    assert "libgdal-xyz" in gis_detect.last_failure()
    assert "libgdal-xyz" in caplog.text


def test_success_clears_the_reason(monkeypatch):
    monkeypatch.setattr(gis_detect, "_import", lambda name: object())
    monkeypatch.setattr(gis_detect, "_has_gdal", lambda: True)
    assert gis_detect.detect_gis() is True
    assert gis_detect.last_failure() is None


def test_improperly_configured_message_names_the_real_cause():
    code = (
        "import sys; sys.path.insert(0, '.');"
        "import apps.core.gis_detect as g;"
        "g._import = lambda name: (_ for _ in ()).throw(OSError('libgdal.so.99 not found'));"
        "import apps.core.geo"
    )
    env = {**os.environ, "DJANGO_SETTINGS_MODULE": "config.settings.base"}
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-c", code], cwd=BACKEND, env=env, capture_output=True, text=True
    )
    assert result.returncode != 0
    assert "ImproperlyConfigured" in result.stderr
    assert "libgdal.so.99 not found" in result.stderr
