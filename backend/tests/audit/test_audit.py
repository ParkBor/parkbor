"""The audit log is on disk: written in the caller's transaction, allowlisted, append-only."""

import logging
import uuid
from datetime import timedelta

import pytest
from django.db import connection, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.audit import services as audit_services
from apps.audit import tasks as audit_tasks
from apps.audit.models import AuditImmutable, AuditLog, purge_allowed
from apps.audit.scrub import plate_hint, scrub
from apps.parking.services import audit
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


def write(**kwargs):
    audit(
        actor=kwargs.pop("actor", None),
        action=kwargs.pop("action", "booking.create"),
        obj_id=kwargs.pop("obj_id", uuid.uuid4()),
        before=kwargs.pop("before", {}),
        after=kwargs.pop("after", {}),
        **kwargs,
    )
    return AuditLog.objects.order_by("-created_at").first()


# --- writing ----------------------------------------------------------------------------------


def test_audit_writes_a_row_immediately_not_on_commit():
    user = make_user("OWNER")
    target = uuid.uuid4()

    row = write(
        actor=user,
        action="parking.approve",
        obj_id=target,
        before={"status": "A"},
        after={"status": "B"},
    )

    assert (row.actor_id, row.action, row.target_type, row.target_id) == (
        user.id,
        "parking.approve",
        "parking",
        str(target),
    )
    assert row.meta == {"before": {"status": "A"}, "after": {"status": "B"}}


def test_the_row_rolls_back_with_the_change_it_describes():
    with pytest.raises(RuntimeError), transaction.atomic():
        audit(actor=None, action="booking.cancel", obj_id=uuid.uuid4(), before={}, after={})
        raise RuntimeError("the business change failed")

    assert AuditLog.objects.count() == 0


def test_the_row_commits_with_the_change():
    with transaction.atomic():
        audit(actor=None, action="booking.cancel", obj_id=uuid.uuid4(), before={}, after={})

    assert AuditLog.objects.count() == 1


def test_a_system_action_and_a_non_user_actor_have_no_actor():
    write(action="booking.expire")
    write(action="booking.expire", actor=object())

    assert set(AuditLog.objects.values_list("actor_id", flat=True)) == {None}


def test_persist_false_only_logs(caplog, django_capture_on_commit_callbacks):
    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        audit(
            actor=None,
            action="operator.checkin",
            obj_id=uuid.uuid4(),
            before={},
            after={"outcome": "qr_invalid"},
            persist=False,
        )

    assert AuditLog.objects.count() == 0
    assert any(r.getMessage() == "audit operator.checkin" for r in caplog.records)


def test_the_logger_line_is_kept_comes_after_commit_and_is_scrubbed_too(
    caplog, django_capture_on_commit_callbacks
):
    user = make_user("ADMIN")
    with caplog.at_level(logging.INFO, logger="habi.audit"):
        with django_capture_on_commit_callbacks(execute=False) as callbacks:
            audit(
                actor=user,
                action="parking.suspend",
                obj_id=1,
                before={"status": "ACTIVE", "phone": "+998901234567"},
                after={"status": "SUSPENDED", "plate_number": "01A123BC", "first_name": "Aziza"},
            )
        assert not [r for r in caplog.records if r.name == "habi.audit"]
        for callback in callbacks:
            callback()

    record = next(r for r in caplog.records if r.name == "habi.audit")
    assert (record.audit_actor, record.audit_action) == (str(user.pk), "parking.suspend")
    line = str(record.__dict__)
    for secret in ("998901234567", "01A123BC", "Aziza"):
        assert secret not in line
    assert record.audit_after["plate_number"] == plate_hint("01A123BC")


def test_a_long_action_or_target_is_cut_not_an_error():
    row = write(action="x." + "a" * 200, obj_id="b" * 200)

    assert len(row.action) == 64 and len(row.target_id) == 64


# --- allowlist --------------------------------------------------------------------------------


def test_only_allowlisted_keys_survive_and_the_dropped_names_are_noted():
    dirty = {
        "phone": "+998901234567",
        "first_name": "Aziza",
        "brand_new_innocent_looking_field": "Aziza Karimova +998901234567",
        "outcome": "completed",
        "amount": "100.00",
    }

    clean = scrub(dirty)

    assert clean == {
        "outcome": "completed",
        "amount": "100.00",
        "_dropped": ["brand_new_innocent_looking_field", "first_name", "phone"],
    }


def test_nested_structures_are_filtered_and_plates_become_hints():
    clean = scrub(
        {
            "before": {"plate_number": "01A123BC", "status": "X"},
            "after": {"nested": {"phone": "1"}, "slot": "s1", "plate": "01A123BC"},
        }
    )

    assert clean["before"] == {"plate_number": plate_hint("01A123BC"), "status": "X"}
    assert clean["after"]["slot"] == "s1"
    assert clean["after"]["plate"] == plate_hint("01A123BC")
    assert clean["after"]["_dropped"] == ["nested"]


def test_audit_rows_never_contain_personal_data():
    row = write(
        action="operator.revoke",
        before={"phone": "+998901234567"},
        after={"name": "Aziza", "plate": "01A123BC", "lot": "x", "telegram_username": "aziza"},
    )

    text = str(row.meta)
    for secret in ("998901234567", "Aziza", "aziza", "01A123BC"):
        assert secret not in text
    assert row.meta["after"]["lot"] == "x"


def test_plate_hint_is_stable_keyed_and_not_reversible():
    assert plate_hint("01A123BC") == plate_hint(" 01a123bc ")
    assert plate_hint("01A123BC") != plate_hint("01A123BD")
    assert plate_hint("01A123BC").startswith("#") and len(plate_hint("01A123BC")) == 9
    assert "01A" not in plate_hint("01A123BC") and "BC" not in plate_hint("01A123BC")


def test_text_is_capped_and_values_are_json_safe():
    clean = scrub({"note": "x" * 1000, "status": object(), "attempts": {1, 2}})

    assert len(clean["note"]) == 200
    assert isinstance(clean["status"], str) and isinstance(clean["attempts"], list)


def test_scrub_is_depth_bounded():
    deep = current = {}
    for _ in range(10):
        current["lot"] = {}
        current = current["lot"]

    assert "<dropped>" in str(scrub({"before": deep}))


# --- append-only ------------------------------------------------------------------------------


def test_existing_rows_cannot_be_saved_again():
    row = write()
    row.action = "tampered"

    with pytest.raises(AuditImmutable):
        row.save()
    assert AuditLog.objects.get(pk=row.pk).action == "booking.create"


def test_rows_cannot_be_deleted_one_by_one_or_by_queryset():
    row = write()

    with pytest.raises(AuditImmutable):
        row.delete()
    with pytest.raises(AuditImmutable):
        AuditLog.objects.all().delete()
    assert AuditLog.objects.count() == 1


def test_rows_cannot_be_bulk_updated():
    write()

    with pytest.raises(AuditImmutable):
        AuditLog.objects.update(action="x")
    with pytest.raises(AuditImmutable):
        AuditLog.objects.bulk_update(list(AuditLog.objects.all()), ["action"])


def test_only_the_purge_context_opens_the_queryset_delete():
    write()

    with purge_allowed():
        deleted, _ = AuditLog.objects.all().delete()

    assert deleted == 1


def test_deleting_an_account_keeps_its_audit_rows_with_no_actor():
    user = make_user("DRIVER")
    write(actor=user)

    user.delete()  # ON DELETE SET NULL is done by the collector, not by AuditLog.update()

    assert AuditLog.objects.get().actor_id is None
    assert not User.objects.filter(pk=user.pk).exists()


# --- retention --------------------------------------------------------------------------------


def old_row(days):
    row = write(action="booking.expire")
    AuditLog.objects.bulk_create([])  # (no-op: keep the manager imported and exercised)
    with purge_allowed(), connection.cursor() as cursor:
        cursor.execute(
            "UPDATE audit_auditlog SET created_at = %s WHERE id = %s",
            [
                timezone.now() - timedelta(days=days),
                row.pk.hex if connection.vendor == "sqlite" else row.pk,
            ],
        )
    return row


def test_purge_deletes_only_rows_older_than_the_retention(settings):
    settings.AUDIT_RETENTION_DAYS = 30
    old = [old_row(31), old_row(400)]
    fresh = [old_row(29), old_row(1)]

    deleted = audit_services.purge()

    assert deleted == 2
    assert set(AuditLog.objects.values_list("pk", flat=True)) == {r.pk for r in fresh}
    assert not AuditLog.objects.filter(pk__in=[r.pk for r in old]).exists()


def test_purge_works_in_batches_and_is_idempotent(settings):
    settings.AUDIT_RETENTION_DAYS = 30
    for _ in range(7):
        old_row(100)

    assert audit_services.purge(batch=3) == 7
    assert audit_services.purge(batch=3) == 0


def test_the_celery_task_runs_the_purge(settings):
    settings.AUDIT_RETENTION_DAYS = 30
    old_row(60)

    assert audit_tasks.purge_audit_log.run() == 1


def test_the_purge_is_scheduled_daily_with_time_limits():
    from config.celery import CELERY_BEAT_SCHEDULE, app

    entry = CELERY_BEAT_SCHEDULE["audit-purge-audit-log"]
    app.loader.import_default_modules()

    assert entry["task"] == "audit.purge_audit_log" and entry["schedule"] == 86400.0
    assert entry["task"] in app.tasks
    assert audit_tasks.purge_audit_log.time_limit and audit_tasks.purge_audit_log.soft_time_limit


# --- schema -----------------------------------------------------------------------------------


def test_indexes_for_the_three_ways_the_log_is_read():
    with connection.cursor() as cursor:
        constraints = connection.introspection.get_constraints(cursor, AuditLog._meta.db_table)
    names = {name for name, info in constraints.items() if info["index"]}

    assert {"auditlog_created", "auditlog_action_created", "auditlog_target"} <= names
