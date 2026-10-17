"""The PostgreSQL branches of the custom migration operations, checked as SQL text (the real
execution is covered by the postgis tests, which CI runs)."""

from types import SimpleNamespace
from unittest import mock

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

from apps.bookings.migration_ops import (
    AddCheckConstraintNotValid,
    AlterFieldNullable,
    ValidateCheckConstraint,
)

pytestmark = pytest.mark.django_db

LATEST = ("bookings", "0005_gate_walk_in_overstay")


@pytest.fixture
def loader():
    return MigrationExecutor(connection).loader


def operations_of(loader, kind):
    return [op for op in loader.get_migration(*LATEST).operations if isinstance(op, kind)]


def run_as_postgres(operation, loader):
    """Run database_forwards against a fake PostgreSQL editor that only records the SQL."""
    state = loader.project_state(LATEST)
    statements = []
    editor = SimpleNamespace(
        connection=SimpleNamespace(vendor="postgresql"),
        quote_name=lambda name: f'"{name}"',
        execute=lambda sql, params=(): statements.append((sql, params)),
    )
    constraint = getattr(operation, "constraint", None)
    if constraint is None:
        operation.database_forwards("bookings", editor, state, state)
        return statements
    sql = f'CONSTRAINT "{constraint.name}" CHECK (...)'
    with mock.patch.object(type(constraint), "constraint_sql", return_value=sql):
        operation.database_forwards("bookings", editor, state, state)
    return statements


def test_user_and_vehicle_become_nullable_without_touching_the_foreign_keys(loader):
    operations = operations_of(loader, AlterFieldNullable)

    assert {op.name for op in operations} == {"user", "vehicle"}
    for op in operations:
        ((sql, _params),) = run_as_postgres(op, loader)
        assert sql.startswith('ALTER TABLE "bookings_booking" ALTER COLUMN')
        assert sql.endswith("DROP NOT NULL")
        assert "FOREIGN KEY" not in sql and "DROP CONSTRAINT" not in sql


def test_checks_are_added_not_valid_and_validated_in_a_later_migration(loader):
    operations = operations_of(loader, AddCheckConstraintNotValid)

    assert {op.constraint.name for op in operations} == {
        "booking_online_has_user_vehicle",
        "booking_kind_valid",
        "booking_overstay_valid",
    }
    for op in operations:
        (add,) = run_as_postgres(op, loader)  # one short statement: no table scan here
        assert add[0].startswith('ALTER TABLE "bookings_booking" ADD CONSTRAINT')
        assert add[0].endswith("NOT VALID") and add[1] is None


def test_validation_is_its_own_non_atomic_migration(loader):
    migration = loader.get_migration("bookings", "0007_validate_gate_checks")
    validations = [op for op in migration.operations if isinstance(op, ValidateCheckConstraint)]

    assert migration.atomic is False
    assert {op.name for op in validations} == {
        "booking_online_has_user_vehicle",
        "booking_kind_valid",
        "booking_overstay_valid",
    }
    for op in validations:
        ((sql, params),) = run_as_postgres(op, loader)
        assert sql == (f'ALTER TABLE "bookings_booking" VALIDATE CONSTRAINT "{op.name}"')
        assert params is None


def test_validation_is_a_no_op_on_other_databases(loader):
    op = ValidateCheckConstraint("booking", "booking_kind_valid")
    state = loader.project_state(LATEST)
    editor = SimpleNamespace(
        connection=SimpleNamespace(vendor="sqlite"),
        execute=lambda *a, **k: pytest.fail("must not run SQL"),
    )

    op.database_forwards("bookings", editor, state, state)
    op.database_backwards("bookings", editor, state, state)


def test_the_stock_path_is_kept_for_sqlite(loader):
    # The test database is SQLite here (or PostGIS in CI); in both cases migrating worked, which
    # is the proof. This asserts the migration really uses the custom operations.
    assert len(operations_of(loader, AlterFieldNullable)) == 2
    assert len(operations_of(loader, AddCheckConstraintNotValid)) == 3
