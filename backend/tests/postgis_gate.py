"""Decide what to do with `postgis`-marked tests (kept pure so it is unit-testable)."""

from enum import Enum


class GateDecision(Enum):
    RUN = "run"
    SKIP = "skip"
    FAIL = "fail"


def decide_postgis_gate(*, has_gis: bool, engine: str, require: bool) -> GateDecision:
    """CI sets REQUIRE_POSTGIS=1: missing GDAL/PostGIS must turn the build red, not green."""
    available = has_gis and "postgis" in engine
    if available:
        return GateDecision.RUN
    return GateDecision.FAIL if require else GateDecision.SKIP
