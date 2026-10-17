"""GDAL/GEOS detection. Must stay free of Django settings/models imports (used by settings)."""

import importlib
import logging

logger = logging.getLogger(__name__)

_import = importlib.import_module  # indirection so tests can simulate a missing library
_last_failure: str | None = None


def _has_gdal() -> bool:
    from django.contrib.gis.gdal import HAS_GDAL

    return bool(HAS_GDAL)


def last_failure() -> str | None:
    """Why the last detect_gis() returned False (None after a success)."""
    return _last_failure


def detect_gis() -> bool:
    """True when GDAL and GEOS can be loaded; otherwise log and remember the real reason."""
    global _last_failure
    try:
        _import("django.contrib.gis.gdal")
        _import("django.contrib.gis.geos")
        available = _has_gdal()
        reason = None if available else "GDAL reported HAS_GDAL = False"
    except Exception as exc:  # noqa: BLE001 - any load failure means "no GIS"; reason is kept
        available = False
        reason = f"{type(exc).__name__}: {exc}"
    _last_failure = reason
    if reason:
        logger.warning("GeoDjango libraries unavailable: %s", reason)
    return available
