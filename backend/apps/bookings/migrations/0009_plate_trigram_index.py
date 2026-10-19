"""Trigram index for the admin plate search (``vehicle_plate ILIKE '%fragment%'``).

PostgreSQL only: pg_trgm + a GIN index, built CONCURRENTLY (a plain CREATE INDEX would block
booking writes on a big table). Other databases (the SQLite dev/test fallback) skip it. The
index is not declared on the model: Django cannot express an extension-guarded index, and
``makemigrations --check`` must stay clean on every backend.

The database user needs the right to ``CREATE EXTENSION pg_trgm`` (a trusted extension since
PostgreSQL 13, so the database owner has it); if it is refused, create the extension once as a
superuser and run the migration again.
"""

from django.db import migrations

INDEX = "booking_plate_trgm"


def create_index(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    schema_editor.execute(
        f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {INDEX} "
        "ON bookings_booking USING gin (vehicle_plate gin_trgm_ops)"
    )


def drop_index(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX}")


class Migration(migrations.Migration):
    atomic = False  # CREATE INDEX CONCURRENTLY cannot run inside a transaction

    dependencies = [("bookings", "0008_booking_settings")]

    operations = [migrations.RunPython(create_index, drop_index)]
