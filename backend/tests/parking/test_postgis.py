"""Spatial behaviour. Needs GDAL/GEOS + PostGIS; auto-skipped elsewhere (see tests/conftest.py)."""

import pytest
from django.db import connection

from tests.helpers import make_user

pytestmark = [pytest.mark.postgis, pytest.mark.django_db]


def test_gist_index_exists_in_database():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'parking_lot' "
            "AND indexname = 'parking_lot_location_gist'"
        )
        row = cursor.fetchone()
    assert row is not None
    assert "USING gist" in row[0]


def test_location_is_geography_point_4326():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT type, srid FROM geography_columns "
            "WHERE f_table_name = 'parking_lot' AND f_geography_column = 'location'"
        )
        assert cursor.fetchone() == ("Point", 4326)


def test_point_roundtrip_and_distance_query():
    from django.contrib.gis.db.models.functions import Distance
    from django.contrib.gis.geos import Point

    from apps.parking.models import ParkingLot

    owner = make_user("OWNER")
    near = ParkingLot.objects.create(
        owner=owner, name="near", address="a", location=Point(69.2401, 41.3111, srid=4326)
    )
    ParkingLot.objects.create(
        owner=owner, name="far", address="b", location=Point(71.7, 40.4, srid=4326)
    )
    origin = Point(69.24, 41.31, srid=4326)
    nearest = ParkingLot.objects.annotate(d=Distance("location", origin)).order_by("d").first()
    assert nearest == near
    assert nearest.location.x == pytest.approx(69.2401)


def test_api_roundtrip_with_real_point():
    from tests.helpers import client_for

    owner = make_user("OWNER")
    response = client_for(owner).post(
        "/api/v1/admin/parkings",
        {"name": "P", "address": "A", "location": {"lat": 41.3, "lng": 69.2}},
        format="json",
    )
    assert response.status_code == 201
    assert response.data["location"] == {"lat": 41.3, "lng": 69.2}
