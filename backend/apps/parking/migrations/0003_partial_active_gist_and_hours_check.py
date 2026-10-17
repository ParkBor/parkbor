"""Partial GiST index for the nearby search + forbid zero-length opening hours.

Index decision: ``parking_lot_loc_active_gist`` (WHERE status = 'ACTIVE') is ADDED next to the
full ``parking_lot_location_gist`` (ARCHITECTURE 7.1, still used by non-ACTIVE spatial queries).
The nearby search only reads ACTIVE lots, so the ordered (KNN) scan over the smaller partial
index cannot walk PENDING/SUSPENDED entries in sparse areas. ``free_slots`` is deliberately NOT in
the predicate: it changes on every booking, which would block HOT updates and bloat the index.

Large tables: ``AddIndex`` takes a SHARE lock that blocks writes while the index builds. When
parking_lot is big, replace the AddIndex below by ``AddIndexConcurrently`` (from
``django.contrib.postgres.operations``) and set ``atomic = False`` on this migration. The table
is tiny today, so the plain operation is used.

Hours: ``open_time == close_time`` was read as "24 h" by the search code, but it is a zero-length
interval by the data model (24/7 is NULL/NULL). Existing equal pairs are normalised to NULL/NULL
(same meaning as before), then the CHECK constraint is added.
"""

import django.contrib.postgres.indexes
from django.conf import settings
from django.db import migrations, models


def normalise_equal_hours(apps, schema_editor):
    lot_model = apps.get_model("parking", "ParkingLot")
    lot_model.objects.filter(open_time=models.F("close_time")).update(
        open_time=None, close_time=None
    )


class Migration(migrations.Migration):
    dependencies = [
        ("parking", "0002_constraints_ordering_limits"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddIndex(
            model_name="parkinglot",
            index=django.contrib.postgres.indexes.GistIndex(
                condition=models.Q(("status", "ACTIVE")),
                fields=["location"],
                name="parking_lot_loc_active_gist",
            ),
        ),
        migrations.RunPython(normalise_equal_hours, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="parkinglot",
            constraint=models.CheckConstraint(
                condition=models.Q(("open_time", models.F("close_time")), _negated=True),
                name="parking_lot_hours_not_zero_length",
            ),
        ),
    ]
