"""Real PostGIS behaviour of the nearby search. Runs in CI (REQUIRE_POSTGIS=1); skipped locally."""

import pytest
from django.db import connection

from apps.core.geomath import haversine_m
from apps.parking import selectors, services
from apps.parking.ranking import NearbyQuery
from tests.helpers import make_user
from tests.parking.nearby.conftest import ORIGIN

pytestmark = [pytest.mark.postgis, pytest.mark.django_db]


def search(**kw):
    base = {
        "lat": ORIGIN[0],
        "lng": ORIGIN[1],
        "radius_m": 3000,
        "slot_type": None,
        "limit": 20,
        "sort": "nearest",
        "only_open": False,
    }
    return services.search_nearby(NearbyQuery(**{**base, **kw}))


def candidates(radius_m=3000, cap=50, slot_type=None):
    return selectors.nearby_candidates(
        lat=ORIGIN[0], lng=ORIGIN[1], radius_m=radius_m, slot_type=slot_type, cap=cap
    )


def test_uses_the_postgis_code_path():
    assert selectors.uses_postgis() is True


def test_knn_order_is_nearest_first(make_nearby_lot):
    for name, metres in [("c", 2000), ("a", 100), ("b", 900), ("d", 2900)]:
        make_nearby_lot(name, metres)
    assert [c.name for c in candidates()] == ["a", "b", "c", "d"]


def test_dwithin_excludes_lots_outside_radius(make_nearby_lot):
    make_nearby_lot("in", 2950)
    make_nearby_lot("out", 3050)
    assert [c.name for c in candidates()] == ["in"]


def test_cap_limits_rows_and_keeps_the_nearest(make_nearby_lot):
    for i in range(6):
        make_nearby_lot(f"l{i}", 100 * (i + 1))
    assert [c.name for c in candidates(cap=2)] == ["l0", "l1"]


def test_east_west_offsets_are_measured_in_metres_not_degrees(make_nearby_lot):
    make_nearby_lot("east", 0, east_metres=2500)
    make_nearby_lot("north", 2600)
    assert [c.name for c in candidates()] == ["east", "north"]


def test_status_and_free_slots_filters(make_nearby_lot):
    make_nearby_lot("ok", 100)
    make_nearby_lot("full", 110, free=0)
    make_nearby_lot("pending", 120, status="PENDING_REVIEW")
    assert [c.name for c in candidates()] == ["ok"]


def test_slot_type_filter(make_nearby_lot, add_slots):
    ev = make_nearby_lot("ev", 300)
    add_slots(ev, "EV", 1)
    make_nearby_lot("plain", 100)
    assert [c.name for c in candidates(slot_type="EV")] == ["ev"]


def test_radius_expansion_against_real_database(make_nearby_lot):
    make_nearby_lot("a", 500)
    make_nearby_lot("b", 3500)
    make_nearby_lot("c", 4500)
    result = search()
    assert result.radius_used_m == 5000
    assert [r.lot.name for r in result.results] == ["a", "b", "c"]


def test_geography_distance_matches_haversine_within_half_a_percent(make_nearby_lot):
    from django.contrib.gis.db.models.functions import Distance
    from django.contrib.gis.geos import Point

    from apps.parking.models import ParkingLot

    lot = make_nearby_lot("a", 2500, east_metres=1500)
    origin = Point(ORIGIN[1], ORIGIN[0], srid=4326)
    db_distance = ParkingLot.objects.annotate(d=Distance("location", origin)).get(pk=lot.pk).d.m
    straight = haversine_m(ORIGIN[0], ORIGIN[1], lot.location.y, lot.location.x)
    assert db_distance == pytest.approx(straight, rel=0.005)
    assert search().results[0].distance_m == pytest.approx(straight, abs=1)


def test_knn_order_by_sql_shape_on_an_empty_table():
    """Trivial shape check (empty table, seqscan forced off): ORDER BY is the bare operator."""
    from apps.parking.models import ParkingLot

    sql, params = ParkingLot.objects.order_by(selectors.knn_order_expression(ORIGIN[0], ORIGIN[1]))[
        :5
    ].query.sql_with_params()
    assert '"parking_lot"."location" <-> ST_GeogFromText(' in sql
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL enable_seqscan = off")
        cursor.execute("EXPLAIN " + sql, params)
        plan = " ".join(row[0] for row in cursor.fetchall())
    assert "parking_lot_location" in plan or "parking_lot_loc_active" in plan


def test_real_candidate_query_uses_a_gist_index_with_default_planner_settings():
    """~10k lots over a wide area, fresh statistics, NO planner overrides: the production query
    (dwithin + KNN + LIMIT 150) must be served by a GiST index, not a sequential scan."""
    import random

    from django.contrib.gis.geos import Point

    from apps.parking.models import ParkingLot

    rng = random.Random(42)  # noqa: S311 - reproducible test data
    owner = make_user("OWNER")
    lots = [
        ParkingLot(
            owner=owner,
            name=f"bulk-{i}",
            address="x",
            location=Point(rng.uniform(68.0, 70.5), rng.uniform(40.5, 42.0), srid=4326),
            status="ACTIVE" if i % 10 else "PENDING_REVIEW",
            free_slots=3,
            total_slots=5,
        )
        for i in range(10_000)
    ]
    ParkingLot.objects.bulk_create(lots, batch_size=1000)
    assert selectors.analyze_parking_lots() is True

    queryset = selectors.nearby_lot_queryset(ORIGIN[0], ORIGIN[1], 11_000, None, 150)
    plan = queryset.explain()

    assert "parking_lot_location_gist" in plan or "parking_lot_loc_active_gist" in plan, plan
    assert "Seq Scan" not in plan, plan


def test_api_with_real_points(make_nearby_lot, driver):
    from tests.helpers import client_for

    make_nearby_lot("a", 300)
    response = client_for(driver).get(
        "/api/v1/parkings/nearby", {"lat": ORIGIN[0], "lng": ORIGIN[1]}
    )
    assert response.status_code == 200
    row = response.json()["results"][0]
    assert row["distance_m"] == pytest.approx(300, abs=3)
    assert row["location"]["lat"] == pytest.approx(ORIGIN[0] + 300 / 111_194.93, abs=1e-5)
