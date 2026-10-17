"""Partial GiST index, ANALYZE helper, and the zero-length opening-hours rule."""

from datetime import time
from pathlib import Path

import pytest
from django.db import IntegrityError, transaction

from apps.parking import selectors
from apps.parking.models import ParkingLot
from tests.helpers import client_for, make_lot, make_user


def test_partial_gist_index_on_active_lots_is_declared_and_old_index_kept():
    indexes = {i.name: i for i in ParkingLot._meta.indexes}
    partial = indexes["parking_lot_loc_active_gist"]
    assert type(partial).__name__ == "GistIndex"
    assert partial.fields == ["location"]
    assert str(partial.condition) == "(AND: ('status', 'ACTIVE'))"
    # the full index stays: ARCHITECTURE 7.1 and non-ACTIVE spatial queries still use it
    assert "parking_lot_location_gist" in indexes


def test_partial_index_predicate_excludes_hot_counters():
    """free_slots changes on every booking; in the predicate it would block HOT updates."""
    index = {i.name: i for i in ParkingLot._meta.indexes}["parking_lot_loc_active_gist"]
    assert "free_slots" not in str(index.condition)


def test_migration_0003_documents_concurrent_creation():
    path = Path(__file__).resolve().parents[3] / "apps/parking/migrations"
    source = next(path.glob("0003_*.py")).read_text(encoding="utf-8")
    assert 'name="parking_lot_loc_active_gist"' in source
    assert "AddIndexConcurrently" in source  # documented procedure for large tables


@pytest.mark.django_db
def test_analyze_runs_only_on_postgresql():
    from django.db import connection

    assert selectors.analyze_parking_lots() is (connection.vendor == "postgresql")


@pytest.mark.django_db
class TestZeroLengthHours:
    URL = "/api/v1/admin/parkings"

    def payload(self, **extra):
        return {
            "name": "P",
            "address": "A",
            "location": {"lat": 41.3, "lng": 69.2},
            **extra,
        }

    def test_create_rejects_equal_open_and_close(self):
        admin = make_user("ADMIN")
        owner = make_user("OWNER")
        response = client_for(admin).post(
            self.URL,
            self.payload(owner=str(owner.pk), open_time="08:00", close_time="08:00"),
            format="json",
        )
        assert response.status_code == 400
        assert "close_time" in response.json()

    def test_patch_rejects_equal_open_and_close(self):
        owner = make_user("OWNER")
        lot = make_lot(owner, open_time=time(8, 0), close_time=time(20, 0))
        response = client_for(owner).patch(
            f"{self.URL}/{lot.pk}", {"close_time": "08:00"}, format="json"
        )
        assert response.status_code == 400

    def test_database_also_refuses_it(self):
        owner = make_user("OWNER")
        with pytest.raises(IntegrityError), transaction.atomic():
            make_lot(owner, open_time=time(8, 0), close_time=time(8, 0))

    def test_null_null_means_24_7_and_is_allowed(self):
        lot = make_lot(make_user("OWNER"))
        assert lot.open_time is None and lot.close_time is None
