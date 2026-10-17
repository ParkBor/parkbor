"""PostgreSQL-only constraints that degrade to no-ops elsewhere.

``ExclusionConstraint`` and range-function ``CHECK``s do not exist on SQLite (the GDAL-less
dev/test database, see tests/conftest.py). These subclasses emit DDL only on PostgreSQL; on
SQLite the same guarantees are enforced in ``services.py`` (overlap check under the lot lock)
and the real database behaviour is verified by the ``@pytest.mark.postgis`` tests in CI.
"""

from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.operations import BtreeGistExtension
from django.db import models


def _is_postgres(schema_editor) -> bool:
    return schema_editor.connection.vendor == "postgresql"


class PostgresOnlyExclusionConstraint(ExclusionConstraint):
    def constraint_sql(self, model, schema_editor):
        return super().constraint_sql(model, schema_editor) if _is_postgres(schema_editor) else None

    def create_sql(self, model, schema_editor):
        return super().create_sql(model, schema_editor) if _is_postgres(schema_editor) else None

    def remove_sql(self, model, schema_editor):
        return super().remove_sql(model, schema_editor) if _is_postgres(schema_editor) else None

    def validate(self, model, instance, exclude=None, using="default"):
        # The ORM-level uniqueness probe uses range operators that SQLite lacks.
        from django.db import connections

        if connections[using].vendor == "postgresql":
            super().validate(model, instance, exclude=exclude, using=using)


class PostgresOnlyCheckConstraint(models.CheckConstraint):
    def constraint_sql(self, model, schema_editor):
        return super().constraint_sql(model, schema_editor) if _is_postgres(schema_editor) else None

    def create_sql(self, model, schema_editor):
        return super().create_sql(model, schema_editor) if _is_postgres(schema_editor) else None

    def remove_sql(self, model, schema_editor):
        return super().remove_sql(model, schema_editor) if _is_postgres(schema_editor) else None

    def validate(self, model, instance, exclude=None, using="default"):
        from django.db import connections

        if connections[using].vendor == "postgresql":
            super().validate(model, instance, exclude=exclude, using=using)


class PortableBtreeGistExtension(BtreeGistExtension):
    """``CREATE EXTENSION btree_gist`` on PostgreSQL; a no-op on SQLite in BOTH directions.

    Stock ``CreateExtension.database_backwards`` probes ``pg_extension`` without checking the
    vendor, which breaks migrating backwards on the SQLite dev/test database.
    """

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        if schema_editor.connection.vendor == "postgresql":
            super().database_backwards(app_label, schema_editor, from_state, to_state)
