"""``period`` column type.

On PostgreSQL this IS ``django.contrib.postgres.fields.DateTimeRangeField`` (``tstzrange``); the
migration state also uses the stock field, so the schema is exactly what ARCHITECTURE 7 shows.

SQLite (GDAL-less dev/test boxes, see tests/conftest.py) has no range type. There the same field
stores ``"<lower ISO>|<upper ISO>"`` text so models stay usable in tests. Nothing queries the
range through the ORM: overlap logic uses the scalar ``starts_at`` / ``ends_at`` columns that
``Booking.save`` derives from ``period``, which keeps one code path for both databases. The real
double-booking guarantee is the EXCLUDE constraint, covered by ``@pytest.mark.postgis`` tests.
"""

from datetime import datetime

from django.contrib.postgres.fields import DateTimeRangeField
from django.db.backends.postgresql.psycopg_any import DateTimeTZRange

_SEPARATOR = "|"
_REAL_FIELD_PATH = "django.contrib.postgres.fields.ranges.DateTimeRangeField"


def make_period(start: datetime, end: datetime) -> DateTimeTZRange:
    """Half-open ``[start, end)`` (an adjacent booking may start exactly when this one ends)."""
    return DateTimeTZRange(start, end, "[)")


class PortableDateTimeRangeField(DateTimeRangeField):
    def get_db_prep_value(self, value, connection, prepared=False):
        if connection.vendor == "postgresql":
            return super().get_db_prep_value(value, connection, prepared)
        value = self.get_prep_value(value)
        if value is None:
            return None
        return f"{value.lower.isoformat()}{_SEPARATOR}{value.upper.isoformat()}"

    def get_placeholder(self, value, compiler, connection):
        if connection.vendor == "postgresql":
            return super().get_placeholder(value, compiler, connection)
        return "%s"

    def from_db_value(self, value, expression, connection):
        if connection.vendor == "postgresql" or value is None:
            return value
        lower, upper = str(value).split(_SEPARATOR)
        return make_period(datetime.fromisoformat(lower), datetime.fromisoformat(upper))

    def deconstruct(self):
        name, _path, args, kwargs = super().deconstruct()
        return name, _REAL_FIELD_PATH, args, kwargs
