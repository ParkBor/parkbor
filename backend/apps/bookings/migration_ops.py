"""Migration operations that keep ``ALTER TABLE`` locks short on PostgreSQL (SQLite: stock path).

* ``AlterFieldNullable``: making a column NULL-able is ``ALTER COLUMN ... DROP NOT NULL`` (a
  catalog change); Django's stock ``AlterField`` would also drop and re-create the foreign key.
  Reversing is refused with a clear message while NULL rows exist (e.g. walk-ins).
* ``AddCheckConstraintNotValid``: ``ADD CONSTRAINT ... NOT VALID`` takes a brief lock and does
  not scan the table; ``ValidateCheckConstraint`` (a separate NON-atomic migration) then scans it
  holding only a weak lock.
"""

from django.db import migrations
from django.db.migrations.operations.base import Operation


def _is_postgres(schema_editor) -> bool:
    return schema_editor.connection.vendor == "postgresql"


class AlterFieldNullable(migrations.AlterField):
    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgres(schema_editor):
            return super().database_forwards(app_label, schema_editor, from_state, to_state)
        self._alter_not_null(app_label, schema_editor, to_state, "DROP NOT NULL")
        return None

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgres(schema_editor):
            return super().database_backwards(app_label, schema_editor, from_state, to_state)
        model = from_state.apps.get_model(app_label, self.model_name)
        column = model._meta.get_field(self.name).column
        quoted_table = schema_editor.quote_name(model._meta.db_table)
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(
                f"SELECT count(*) FROM {quoted_table} "  # noqa: S608 - quoted identifiers
                f"WHERE {schema_editor.quote_name(column)} IS NULL"
            )
            orphans = cursor.fetchone()[0]
        if orphans:
            raise RuntimeError(
                f"Cannot reverse: {orphans} row(s) of {model._meta.db_table} have {column} NULL "
                "(walk-in bookings). Delete or reassign them first."
            )
        self._alter_not_null(app_label, schema_editor, to_state, "SET NOT NULL")
        return None

    def _alter_not_null(self, app_label, schema_editor, state, action: str) -> None:
        model = state.apps.get_model(app_label, self.model_name)
        column = model._meta.get_field(self.name).column
        schema_editor.execute(
            f"ALTER TABLE {schema_editor.quote_name(model._meta.db_table)} "
            f"ALTER COLUMN {schema_editor.quote_name(column)} {action}"
        )


class AddCheckConstraintNotValid(migrations.AddConstraint):
    """``ADD CONSTRAINT ... NOT VALID``: a brief lock, no table scan. The scan happens later, in
    ``ValidateCheckConstraint`` (its own non-atomic migration), so the strong lock taken here is
    released before the long part starts."""

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgres(schema_editor):
            return super().database_forwards(app_label, schema_editor, from_state, to_state)
        model = to_state.apps.get_model(app_label, self.model_name)
        table = schema_editor.quote_name(model._meta.db_table)
        definition = self.constraint.constraint_sql(model, schema_editor)
        schema_editor.execute(f"ALTER TABLE {table} ADD {definition} NOT VALID", params=None)
        return None


class ValidateCheckConstraint(Operation):
    """``VALIDATE CONSTRAINT``: scans the table holding only a weak lock (writes continue).
    PostgreSQL only; a no-op elsewhere (the other databases validated while adding)."""

    reversible = True

    def __init__(self, model_name, name):
        self.model_name = model_name
        self.name = name

    def state_forwards(self, app_label, state):
        pass

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if not _is_postgres(schema_editor):
            return
        model = to_state.apps.get_model(app_label, self.model_name)
        schema_editor.execute(
            f"ALTER TABLE {schema_editor.quote_name(model._meta.db_table)} "
            f"VALIDATE CONSTRAINT {schema_editor.quote_name(self.name)}",
            params=None,
        )

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        pass

    def describe(self):
        return f"Validate constraint {self.name} on {self.model_name}"
