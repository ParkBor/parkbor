"""Audit logging format/commit semantics, empty PATCH, lock ordering."""

import json
import logging
from unittest import mock

import pytest
from django.db import transaction

from apps.core.logging_utils import ExtraFieldsFormatter
from apps.parking import services
from apps.parking.models import Slot, Tariff, Zone

pytestmark = pytest.mark.django_db


class TestAuditLogging:
    def test_audit_logger_is_enabled_at_info_by_project_config(self):
        assert logging.getLogger("habi.audit").isEnabledFor(logging.INFO)

    def test_formatter_prints_extra_fields_as_json(self):
        record = logging.LogRecord(
            "habi.audit", logging.INFO, __file__, 1, "audit %s", ("x",), None
        )
        record.audit_actor = "u1"
        record.audit_before = {"status": "PENDING_REVIEW"}
        record.audit_after = {"status": "ACTIVE"}
        line = ExtraFieldsFormatter("%(name)s %(message)s").format(record)
        assert line.startswith("habi.audit audit x ")
        extras = json.loads(line.split(" ", 3)[3])
        assert extras == {
            "audit_actor": "u1",
            "audit_before": {"status": "PENDING_REVIEW"},
            "audit_after": {"status": "ACTIVE"},
        }

    def test_formatter_without_extras_is_plain(self):
        record = logging.LogRecord("x", logging.INFO, __file__, 1, "hello", (), None)
        assert ExtraFieldsFormatter("%(message)s").format(record) == "hello"

    def test_project_handler_uses_the_extra_aware_formatter(self):
        handlers = logging.getLogger("habi.audit").handlers
        assert any(isinstance(h.formatter, ExtraFieldsFormatter) for h in handlers)

    def test_audit_line_is_logged_after_commit_with_actor_before_after(
        self, admin_user, lot_a, caplog, django_capture_on_commit_callbacks
    ):
        with caplog.at_level(logging.INFO, logger="habi.audit"):
            with django_capture_on_commit_callbacks(execute=False) as callbacks:
                services.change_lot_status(lot=lot_a, actor=admin_user, action="approve")
            assert not [r for r in caplog.records if r.name == "habi.audit"]  # not before commit
            for callback in callbacks:
                callback()
        record = next(r for r in caplog.records if r.name == "habi.audit")
        assert record.audit_actor == str(admin_user.pk)
        assert record.audit_before == {"status": "PENDING_REVIEW"}
        assert record.audit_after == {"status": "ACTIVE"}

    def test_rolled_back_change_is_not_logged(
        self, admin_user, lot_a, caplog, django_capture_on_commit_callbacks
    ):
        with caplog.at_level(logging.INFO, logger="habi.audit"):
            with django_capture_on_commit_callbacks(execute=True):
                with pytest.raises(RuntimeError), transaction.atomic():
                    services.change_lot_status(lot=lot_a, actor=admin_user, action="approve")
                    raise RuntimeError("boom")
        assert not [r for r in caplog.records if r.name == "habi.audit"]


class TestEmptyPatchDoesNotRewriteRows:
    def test_zone(self, zone_a):
        with mock.patch.object(Zone, "save") as save:
            services.save_zone(instance=zone_a, data={})
        save.assert_not_called()

    def test_tariff(self, tariff_b):
        with mock.patch.object(Tariff, "save") as save:
            services.save_tariff(instance=tariff_b, data={})
        save.assert_not_called()

    def test_non_empty_patch_writes_only_given_columns(self, zone_a):
        with mock.patch.object(Zone, "save") as save:
            services.save_zone(instance=zone_a, data={"floor": 2})
        save.assert_called_once_with(update_fields=["floor"])

    def test_empty_patch_over_http_is_200(self, admin_user, zone_a, tariff_b):
        from tests.helpers import client_for

        client = client_for(admin_user)
        assert client.patch(f"/api/v1/admin/zones/{zone_a.id}", {}).status_code == 200
        assert client.patch(f"/api/v1/admin/tariffs/{tariff_b.id}", {}).status_code == 200


class TestLockOrder:
    """The lot row must be locked BEFORE any slot/zone row is touched (lot -> slot order)."""

    @pytest.fixture
    def calls(self):
        log: list[str] = []
        real = services._lock_lot

        def locked(lot_id):
            log.append("lock")
            return real(lot_id)

        with mock.patch.object(services, "_lock_lot", side_effect=locked):
            yield log

    def test_create_slot(self, calls, zone_a):
        real = Slot.objects.create

        def create(**kw):
            calls.append("write")
            return real(**kw)

        with mock.patch.object(Slot.objects, "create", side_effect=create):
            services.save_slot(instance=None, data={"zone": zone_a, "code": "L-1"})
        assert calls[:2] == ["lock", "write"]

    def test_update_slot(self, calls, slot_a):
        real = Slot.save

        def save(self, *a, **kw):
            calls.append("write")
            return real(self, *a, **kw)

        with mock.patch.object(Slot, "save", save):
            services.save_slot(instance=slot_a, data={"distance_to_entrance": 4})
        assert calls[:2] == ["lock", "write"]

    def test_delete_slot(self, calls, slot_a):
        real = Slot.delete

        def delete(self, *a, **kw):
            calls.append("write")
            return real(self, *a, **kw)

        with mock.patch.object(Slot, "delete", delete):
            services.delete_slot(slot=slot_a)
        assert calls[:2] == ["lock", "write"]

    def test_delete_zone(self, calls, zone_a):
        real = Zone.delete

        def delete(self, *a, **kw):
            calls.append("write")
            return real(self, *a, **kw)

        with mock.patch.object(Zone, "delete", delete):
            services.delete_zone(zone=zone_a)
        assert calls[:2] == ["lock", "write"]

    def test_bulk_create(self, calls, zone_a):
        real = Slot.objects.bulk_create

        def bulk(objs, **kw):
            calls.append("write")
            return real(objs, **kw)

        with mock.patch.object(Slot.objects, "bulk_create", side_effect=bulk):
            services.bulk_create_slots(zone=zone_a, prefix="B", start=1, end=3)
        assert calls[:2] == ["lock", "write"]
