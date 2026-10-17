"""Service-layer behaviour: stale writes, locking, integrity races, deletes, audit hook."""

import logging
from unittest import mock

import pytest
from django.db.models import ProtectedError

from apps.core.exceptions import ApiError
from apps.parking import services
from apps.parking.models import LotStatus, ParkingLot, Slot, SlotStatus, Tariff, Zone

pytestmark = pytest.mark.django_db


def _conflict_status(exc_info):
    return exc_info.value.status_code


class TestStaleWrites:
    def test_stale_lot_does_not_overwrite_moderation(self, admin_user, owner_a, lot_a):
        stale = ParkingLot.objects.get(pk=lot_a.pk)  # loaded while PENDING_REVIEW
        services.change_lot_status(lot=lot_a, actor=admin_user, action="approve")
        services.update_lot(lot=stale, data={"open_time": None}, actor=owner_a)
        lot_a.refresh_from_db()
        assert lot_a.status == LotStatus.ACTIVE

    def test_stale_lot_cannot_undo_suspension(self, admin_user, owner_a, lot_a):
        stale = ParkingLot.objects.get(pk=lot_a.pk)
        services.change_lot_status(lot=lot_a, actor=admin_user, action="suspend")
        services.update_lot(lot=stale, data={"open_time": None}, actor=owner_a)
        lot_a.refresh_from_db()
        assert lot_a.status == LotStatus.SUSPENDED

    def test_stale_slot_does_not_overwrite_unrelated_fields(self, zone_a, slot_a):
        stale = Slot.objects.get(pk=slot_a.pk)
        Slot.objects.filter(pk=slot_a.pk).update(status=SlotStatus.OCCUPIED)
        services.save_slot(instance=stale, data={"distance_to_entrance": 7})
        slot_a.refresh_from_db()
        assert slot_a.status == SlotStatus.OCCUPIED
        assert slot_a.distance_to_entrance == 7

    def test_slot_zone_cannot_change(self, lot_a, zone_a, slot_a):
        other = Zone.objects.create(parking_lot=lot_a, name="B")
        with pytest.raises(ApiError) as exc:
            services.save_slot(instance=slot_a, data={"zone": other})
        assert exc.value.status_code == 400


class TestLocking:
    def test_counter_changes_lock_the_lot_row_first(self, zone_a, slot_a):
        with mock.patch.object(services, "_lock_lot", wraps=services._lock_lot) as lock:
            services.save_slot(instance=slot_a, data={"status": SlotStatus.OUT_OF_SERVICE})
            services.delete_slot(slot=slot_a)
            services.bulk_create_slots(zone=zone_a, prefix="Z", start=1, end=2)
        assert lock.call_count == 3

    def test_counters_match_reality_after_mixed_operations(self, lot_a, zone_a):
        services.bulk_create_slots(zone=zone_a, prefix="A", start=1, end=10)
        Slot.objects.filter(zone=zone_a, code="A-1").update(status=SlotStatus.OCCUPIED)
        services.recalculate_counters(lot_a)
        lot_a.refresh_from_db()
        assert (lot_a.total_slots, lot_a.free_slots) == (10, 9)


class TestIntegrityRaces:
    def test_duplicate_slot_code_is_409(self, zone_a, slot_a):
        with pytest.raises(ApiError) as exc:
            services.save_slot(instance=None, data={"zone": zone_a, "code": slot_a.code})
        assert exc.value.status_code == 409

    def test_bulk_with_existing_code_is_409_and_atomic(self, zone_a, slot_a):
        with pytest.raises(ApiError) as exc:
            services.bulk_create_slots(zone=zone_a, prefix="A", start=1, end=5)
        assert exc.value.status_code == 409
        assert zone_a.slots.count() == 1

    def test_bulk_integrity_error_after_precheck_is_409(self, zone_a):
        with (
            mock.patch.object(Slot.objects, "bulk_create", side_effect=_integrity()),
            pytest.raises(ApiError) as exc,
        ):
            services.bulk_create_slots(zone=zone_a, prefix="A", start=1, end=3)
        assert exc.value.status_code == 409

    def test_duplicate_zone_is_409(self, lot_a, zone_a):
        with pytest.raises(ApiError) as exc:
            services.save_zone(instance=None, data={"parking_lot": lot_a, "name": zone_a.name})
        assert exc.value.status_code == 409

    def test_duplicate_tariff_is_409(self, lot_b, tariff_b):
        with pytest.raises(ApiError) as exc:
            services.save_tariff(
                instance=None,
                data={"parking_lot": lot_b, "slot_type": "STANDARD", "price_per_hour": "1"},
            )
        assert exc.value.status_code == 409
        assert Tariff.objects.count() == 1

    def test_create_lot_integrity_error_is_409(self, owner_a):
        with (
            mock.patch.object(ParkingLot.objects, "create", side_effect=_integrity()),
            pytest.raises(ApiError) as exc,
        ):
            services.create_lot(
                data={"owner": owner_a, "name": "x", "address": "y", "location": (69.0, 41.0)}
            )
        assert exc.value.status_code == 409


def _integrity():
    from django.db import IntegrityError

    return IntegrityError("duplicate")


class TestDeletes:
    def test_active_lot_cannot_be_deleted(self, admin_user, lot_a):
        services.change_lot_status(lot=lot_a, actor=admin_user, action="approve")
        lot_a.refresh_from_db()
        with pytest.raises(ApiError) as exc:
            services.delete_lot(lot=lot_a, actor=admin_user)
        assert exc.value.status_code == 409
        assert ParkingLot.objects.filter(pk=lot_a.pk).exists()

    def test_pending_lot_can_be_deleted(self, admin_user, lot_a):
        services.delete_lot(lot=lot_a, actor=admin_user)
        assert not ParkingLot.objects.filter(pk=lot_a.pk).exists()

    @pytest.mark.parametrize(
        ("model", "call"),
        [
            (Slot, lambda s: services.delete_slot(slot=s)),
            (Zone, lambda s: services.delete_zone(zone=s.zone)),
            (ParkingLot, lambda s: services.delete_lot(lot=s.zone.parking_lot, actor=None)),
        ],
    )
    def test_protected_error_becomes_409(self, slot_a, model, call):
        error = ProtectedError("protected by bookings", {slot_a})
        with mock.patch.object(model, "delete", side_effect=error), pytest.raises(ApiError) as exc:
            call(slot_a)
        assert exc.value.status_code == 409


class TestReReview:
    def _active(self, admin_user, lot):
        services.change_lot_status(lot=lot, actor=admin_user, action="approve")
        lot.refresh_from_db()
        return lot

    def test_owner_changing_name_of_active_lot_requires_review(self, admin_user, owner_a, lot_a):
        lot = self._active(admin_user, lot_a)
        services.update_lot(lot=lot, data={"name": "Renamed"}, actor=owner_a)
        lot.refresh_from_db()
        assert lot.status == LotStatus.PENDING_REVIEW

    def test_owner_changing_location_requires_review(self, admin_user, owner_a, lot_a):
        lot = self._active(admin_user, lot_a)
        services.update_lot(lot=lot, data={"location": (70.0, 41.0)}, actor=owner_a)
        lot.refresh_from_db()
        assert lot.status == LotStatus.PENDING_REVIEW

    def test_owner_changing_working_hours_keeps_active(self, admin_user, owner_a, lot_a):
        lot = self._active(admin_user, lot_a)
        services.update_lot(
            lot=lot, data={"open_time": "08:00", "close_time": "20:00"}, actor=owner_a
        )
        lot.refresh_from_db()
        assert lot.status == LotStatus.ACTIVE

    def test_same_value_is_not_a_change(self, admin_user, owner_a, lot_a):
        lot = self._active(admin_user, lot_a)
        services.update_lot(lot=lot, data={"name": lot.name}, actor=owner_a)
        lot.refresh_from_db()
        assert lot.status == LotStatus.ACTIVE

    def test_admin_edit_keeps_active(self, admin_user, lot_a):
        lot = self._active(admin_user, lot_a)
        services.update_lot(lot=lot, data={"name": "Renamed"}, actor=admin_user)
        lot.refresh_from_db()
        assert lot.status == LotStatus.ACTIVE

    def test_suspended_lot_stays_suspended(self, admin_user, owner_a, lot_a):
        services.change_lot_status(lot=lot_a, actor=admin_user, action="suspend")
        lot_a.refresh_from_db()
        services.update_lot(lot=lot_a, data={"name": "Renamed"}, actor=owner_a)
        lot_a.refresh_from_db()
        assert lot_a.status == LotStatus.SUSPENDED


class TestAuditHook:
    def test_moderation_emits_audit_record(
        self, admin_user, lot_a, caplog, django_capture_on_commit_callbacks
    ):
        with (
            caplog.at_level(logging.INFO, logger="habi.audit"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            services.change_lot_status(lot=lot_a, actor=admin_user, action="approve")
        record = next(r for r in caplog.records if r.name == "habi.audit")
        assert record.audit_action == "parking.approve"
        assert record.audit_object == str(lot_a.pk)
        assert record.audit_before == {"status": "PENDING_REVIEW"}
        assert record.audit_after == {"status": "ACTIVE"}

    def test_non_admin_cannot_moderate(self, owner_a, lot_a):
        with pytest.raises(ApiError) as exc:
            services.change_lot_status(lot=lot_a, actor=owner_a, action="approve")
        assert exc.value.status_code == 403
