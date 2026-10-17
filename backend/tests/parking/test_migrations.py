"""Migration checks that need neither GDAL nor a database."""

import ast
from pathlib import Path

from django.apps import apps
from django.db.migrations.autodetector import MigrationAutodetector
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.state import ProjectState

MIGRATIONS = Path(__file__).resolve().parents[2] / "apps" / "parking" / "migrations"


def _initial_source() -> str:
    return (MIGRATIONS / "0001_initial.py").read_text(encoding="utf-8")


def test_migration_files_are_valid_python():
    files = [p for p in MIGRATIONS.glob("*.py") if p.name != "__init__.py"]
    assert files
    for path in files:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def test_initial_migration_declares_gist_index_on_location():
    source = _initial_source()
    assert "django.contrib.postgres.indexes.GistIndex" in source
    assert 'name="parking_lot_location_gist"' in source
    assert 'fields=["location"]' in source
    assert "geography=True" in source


def test_migrations_are_in_sync_with_models():
    loader = MigrationLoader(None, ignore_no_migrations=True)
    changes = MigrationAutodetector(loader.project_state(), ProjectState.from_apps(apps)).changes(
        graph=loader.graph
    )
    assert "parking" not in changes, f"missing migrations: {changes.get('parking')}"
