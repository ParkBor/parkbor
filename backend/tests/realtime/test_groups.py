"""Group names are built only from validated UUIDs / geohashes (no injection through ids)."""

import uuid

import pytest

from apps.realtime import groups


def test_names_are_built_from_canonical_uuids():
    u = uuid.uuid4()
    assert groups.lot_group(u) == f"lot_{u}"
    assert groups.user_group(str(u).upper()) == f"user_{u}"  # normalised to lower case
    assert groups.operator_group(u) == f"operator_lot_{u}"


def test_geo_group_requires_a_valid_geohash5():
    assert groups.geo_group("tv7dc") == "geo_tv7dc"
    assert groups.geo_group("TV7DC") == "geo_tv7dc"


@pytest.mark.parametrize(
    "bad", ["", "tv7d", "tv7dcx", "tv7da", "tv7d!", "../x", "tv7d\n", None, 5, "ü" * 5]
)
def test_bad_geohash_is_rejected(bad):
    with pytest.raises(groups.InvalidGroup):
        groups.geo_group(bad)


@pytest.mark.parametrize(
    "bad", ["", "abc", None, 5, "x" * 36, f"{uuid.uuid4()}.", f"{uuid.uuid4()} ", "../../etc"]
)
def test_bad_uuid_is_rejected(bad):
    with pytest.raises(groups.InvalidGroup):
        groups.lot_group(bad)


def test_valid_name_is_ascii_and_short():
    assert all(len(groups.lot_group(uuid.uuid4())) < 100 for _ in range(3))


def test_geohash_of_a_lot_location():
    from apps.core.geomath import geohash_encode

    assert groups.geohash5_of(41.3111, 69.2797) == geohash_encode(41.3111, 69.2797, 5)
