"""Real PostgreSQL behaviour of the gate: one-time QR under 50 threads, lot-first locking without
deadlocks, races with cancel / no-show / overstay sweeps, walk-in vs booking (EXCLUDE).

Row locks and range constraints do not exist on SQLite, so these are skipped locally (`postgis`
marker, tests/conftest.py) and MUST run in CI (REQUIRE_POSTGIS=1). NOT run in the environment
this step was written in (no PostgreSQL there): they are the first thing to check in CI.
"""

import uuid
from datetime import timedelta

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.bookings import checkin, checkout, services, walkin
from apps.bookings.errors import NoSlotAvailable
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingKind
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError
from apps.parking.models import ParkingLot, Slot, SlotStatus
from tests.bookings.factories import make_booking, make_vehicle
from tests.helpers import make_user
from tests.operators.helpers import book, entry_token, exit_token, make_gate
from tests.operators.parallel import run_parallel

pytestmark = [pytest.mark.postgis, pytest.mark.django_db(transaction=True)]

PARALLEL = 50


def booked(gate, **kwargs):
    """A booking of a fresh driver with a fresh plate (one plate cannot be in two bookings at once
    on PostgreSQL: the vehicle EXCLUDE constraint)."""
    kwargs.setdefault("user", make_user("DRIVER"))
    kwargs.setdefault("vehicle", make_vehicle(kwargs["user"]))
    return book(gate, **kwargs)


def code_of(error) -> str:
    return str(error.detail["code"])


def free_count(gate) -> int:
    return Slot.objects.filter(zone__parking_lot=gate.lot, status=SlotStatus.FREE).count()


def assert_counters_exact(gate):
    lot = ParkingLot.objects.get(pk=gate.lot.pk)
    assert lot.free_slots == free_count(gate)
    assert lot.total_slots == Slot.objects.filter(zone__parking_lot=gate.lot).count()


def only_clean_losses(results, allowed_codes):
    """Every failure must be a clean API answer with one of the expected codes."""
    for ok, result in results:
        if not ok:
            assert isinstance(result, ApiError), result
            assert code_of(result) in allowed_codes, code_of(result)


# --- one QR, fifty scanners -------------------------------------------------------------------


class TestOneTimeQr:
    def test_fifty_threads_scan_one_qr_exactly_one_checks_in(self):
        gate = make_gate()
        booking = booked(gate)
        token = entry_token(booking)

        results = run_parallel(
            [
                lambda: checkin.check_in(operator=gate.operator, token=token, now=gate.now)
                for _ in range(PARALLEL)
            ]
        )

        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        outcomes = [r.code for _ok, r in results]
        assert outcomes.count("checked_in") == 1
        assert outcomes.count("already_checked_in") == PARALLEL - 1
        assert sum(1 for _ok, r in results if r.allowed) == 1  # only ONE admission (green)
        booking.refresh_from_db()
        assert booking.status == S.ACTIVE
        assert BookingEvent.objects.filter(booking=booking, to_status=S.ACTIVE).count() == 1
        assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.OCCUPIED
        assert_counters_exact(gate)

    def test_fifty_threads_with_the_nonce_already_spent_all_lose(self):
        gate = make_gate()
        booking = booked(gate, qr_nonce_used_at=gate.now)
        token = entry_token(booking)

        results = run_parallel(
            [
                lambda: checkin.check_in(operator=gate.operator, token=token, now=gate.now)
                for _ in range(PARALLEL)
            ]
        )

        assert not any(ok for ok, _ in results)
        only_clean_losses(results, {"already_used"})
        assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED

    def test_fifty_threads_scan_one_exit_qr_exactly_one_completes(self):
        gate = make_gate()
        booking = book(
            gate,
            status=S.ACTIVE,
            start_min=-60,
            end_min=60,
            checked_in_at=gate.now - timedelta(minutes=60),
        )
        Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)
        token = exit_token(booking, gate.now)

        results = run_parallel(
            [
                lambda: checkout.check_out(operator=gate.operator, token=token, now=gate.now)
                for _ in range(PARALLEL)
            ]
        )

        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        outcomes = [r.code for _ok, r in results]
        assert outcomes.count("completed") == 1
        assert outcomes.count("already_completed") == PARALLEL - 1
        assert BookingEvent.objects.filter(booking=booking, to_status=S.COMPLETED).count() == 1
        assert_counters_exact(gate)


# --- many cars, one lot -----------------------------------------------------------------------


class TestLotCounters:
    def test_parallel_check_ins_and_check_outs_keep_free_slots_exact(self):
        gate = make_gate(slots=12)
        entering, leaving = [], []
        for index, slot in enumerate(gate.slots):
            driver = make_user("DRIVER")
            vehicle = make_vehicle(driver)
            if index < 6:
                entering.append(
                    booked(gate, slot=slot, user=driver, vehicle=vehicle, start_min=-3, end_min=90)
                )
            else:
                leaving.append(
                    book(
                        gate,
                        slot=slot,
                        user=driver,
                        vehicle=vehicle,
                        status=S.ACTIVE,
                        start_min=-60,
                        end_min=60,
                        checked_in_at=gate.now - timedelta(minutes=60),
                    )
                )
                Slot.objects.filter(pk=slot.pk).update(status=SlotStatus.OCCUPIED)
        ParkingLot.objects.filter(pk=gate.lot.pk).update(free_slots=6)

        jobs = [
            lambda b=b: checkin.check_in(operator=gate.operator, token=entry_token(b), now=gate.now)
            for b in entering
        ] + [
            lambda b=b: checkout.check_out(
                operator=gate.operator,
                token=exit_token(b, gate.now),
                now=gate.now,
            )
            for b in leaving
        ]
        results = run_parallel(jobs)

        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        assert free_count(gate) == 6
        assert_counters_exact(gate)


# --- races with other writers -----------------------------------------------------------------


class TestRaces:
    @pytest.mark.parametrize("round_", range(5))
    def test_check_in_versus_cancel_never_both(self, round_):
        gate = make_gate()
        booking = booked(gate)
        token = entry_token(booking)

        results = run_parallel(
            [
                lambda: checkin.check_in(operator=gate.operator, token=token, now=gate.now),
                lambda: services.cancel_booking(
                    booking_id=booking.pk, user=booking.user, now=gate.now
                ),
            ]
        )

        booking.refresh_from_db()
        slot = Slot.objects.get(pk=gate.slot.pk)
        in_ok, in_result = results[0]
        cancel_ok, _cancel_result = results[1]
        assert booking.status in (S.ACTIVE, S.CANCELLED)
        if booking.status == S.ACTIVE:
            assert in_ok and not cancel_ok
            assert slot.status == SlotStatus.OCCUPIED
        else:
            assert cancel_ok and not in_ok
            assert code_of(in_result) == "booking_cancelled"
            assert slot.status == SlotStatus.FREE
            assert booking.qr_nonce_used_at is None  # the lost check-in burnt nothing
        assert_counters_exact(gate)

    @pytest.mark.parametrize("round_", range(5))
    def test_check_in_versus_the_no_show_sweep_exactly_one_wins(self, round_):
        gate = make_gate()
        booking = booked(gate, start_min=-19, end_min=100)
        token = entry_token(booking)
        sweep_time = gate.now + timedelta(minutes=2)  # start + 21 minutes: now a no-show

        results = run_parallel(
            [
                lambda: checkin.check_in(operator=gate.operator, token=token, now=gate.now),
                lambda: services.mark_no_shows(now=sweep_time),
            ]
        )

        booking.refresh_from_db()
        assert booking.status in (S.ACTIVE, S.NO_SHOW)
        in_ok, in_result = results[0]
        if booking.status == S.ACTIVE:
            assert in_ok
            assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.OCCUPIED
        else:
            assert not in_ok and code_of(in_result) == "booking_no_show"
            assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.FREE
        assert_counters_exact(gate)

    @pytest.mark.parametrize("round_", range(5))
    def test_check_out_versus_the_overstay_sweep(self, round_):
        gate = make_gate()
        booking = book(
            gate,
            status=S.ACTIVE,
            start_min=-120,
            end_min=-1,
            checked_in_at=gate.now - timedelta(minutes=120),
        )
        Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)

        results = run_parallel(
            [
                lambda: checkout.check_out(
                    operator=gate.operator,
                    token=exit_token(booking, gate.now),
                    now=gate.now,
                ),
                lambda: services.detect_overstays(now=gate.now),
            ]
        )

        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        booking.refresh_from_db()
        assert booking.status == S.COMPLETED  # whichever ran first, the car has left
        assert booking.overstay_minutes == 1
        assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.FREE
        statuses = list(booking.events.values_list("to_status", flat=True))
        assert statuses.count(S.COMPLETED) == 1
        assert_counters_exact(gate)

    def test_walk_in_versus_an_online_booking_one_slot_one_winner(self):
        gate = make_gate(slots=1)
        driver = make_user("DRIVER")
        vehicle = make_vehicle(driver)

        results = run_parallel(
            [
                lambda: walkin.register_walk_in(
                    operator=gate.operator,
                    slot_id=gate.slot.pk,
                    plate_number="01A777BC",
                    vehicle_type="CAR",
                    now=gate.now,
                ),
                lambda: services.create_booking(
                    user=driver,
                    lot_id=gate.lot.pk,
                    slot_type="STANDARD",
                    vehicle=vehicle,
                    start=gate.now + timedelta(minutes=5),
                    end=gate.now + timedelta(hours=2),
                    now=gate.now,
                ),
            ]
        )

        walk_ok, walk_result = results[0]
        book_ok, book_result = results[1]
        assert walk_ok or book_ok  # the slot is never left unused by two refusals
        live = list(
            Booking.objects.filter(
                slot=gate.slot, status__in=["PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "OVERSTAY"]
            )
        )
        for a, b in zip(live, live[1:], strict=False):
            assert a.ends_at <= b.starts_at or b.ends_at <= a.starts_at
        if walk_ok and book_ok:  # both fit only if the walk-in was cut short in front of it
            assert walk_result.ends_at <= book_result.starts_at
        elif not walk_ok:
            assert code_of(walk_result) in ("slot_reserved_soon", "slot_occupied")
        else:
            assert isinstance(book_result, NoSlotAvailable)

    def test_two_walk_ins_for_one_slot(self):
        gate = make_gate(slots=1)

        results = run_parallel(
            [
                lambda p=plate: walkin.register_walk_in(
                    operator=gate.operator,
                    slot_id=gate.slot.pk,
                    plate_number=p,
                    vehicle_type="CAR",
                    now=gate.now,
                )
                for plate in ("01A111BC", "01A222BC", "01A333BC", "01A444BC")
            ]
        )

        assert sum(1 for ok, _ in results if ok) == 1
        only_clean_losses(results, {"slot_occupied", "slot_reserved_soon"})
        assert Booking.objects.filter(kind=BookingKind.WALK_IN).count() == 1

    def test_the_same_plate_walks_in_to_two_slots_only_once(self):
        gate = make_gate(slots=2)

        results = run_parallel(
            [
                lambda s=slot: walkin.register_walk_in(
                    operator=gate.operator,
                    slot_id=s.pk,
                    plate_number="01A777BC",
                    vehicle_type="CAR",
                    now=gate.now,
                )
                for slot in gate.slots
            ]
        )

        assert sum(1 for ok, _ in results if ok) == 1
        for ok, error in results:
            if not ok:
                assert code_of(error) == "plate_busy"
        assert_counters_exact(gate)


# --- the whole gate at once -------------------------------------------------------------------


class TestNoDeadlocks:
    def test_mixed_gate_traffic_on_one_lot_finishes_cleanly(self):
        gate = make_gate(slots=10)
        jobs = []
        for slot in gate.slots[:3]:  # arrivals
            booking = booked(gate, slot=slot, start_min=-3, end_min=90)
            jobs.append(
                lambda b=booking: checkin.check_in(
                    operator=gate.operator, token=entry_token(b), now=gate.now
                )
            )
        for slot in gate.slots[3:5]:  # departures
            booking = booked(
                gate,
                slot=slot,
                status=S.ACTIVE,
                start_min=-60,
                end_min=60,
                checked_in_at=gate.now - timedelta(minutes=60),
            )
            Slot.objects.filter(pk=slot.pk).update(status=SlotStatus.OCCUPIED)
            jobs.append(
                lambda b=booking: checkout.check_out(
                    operator=gate.operator,
                    token=exit_token(b, gate.now),
                    now=gate.now,
                )
            )
        for index, slot in enumerate(gate.slots[5:7]):  # walk-ins
            jobs.append(
                lambda s=slot, i=index: walkin.register_walk_in(
                    operator=gate.operator,
                    slot_id=s.pk,
                    plate_number=f"01A90{i}BC",
                    vehicle_type="CAR",
                    now=gate.now,
                )
            )
        cancel_me = booked(gate, slot=gate.slots[7], start_min=60, end_min=120)
        jobs.append(
            lambda: services.cancel_booking(
                booking_id=cancel_me.pk, user=cancel_me.user, now=gate.now
            )
        )
        for _ in range(4):  # online bookings
            driver = make_user("DRIVER")
            vehicle = make_vehicle(driver)
            jobs.append(
                lambda u=driver, v=vehicle: services.create_booking(
                    user=u,
                    lot_id=gate.lot.pk,
                    slot_type="STANDARD",
                    vehicle=v,
                    start=gate.now + timedelta(hours=5),
                    end=gate.now + timedelta(hours=6),
                    now=gate.now,
                )
            )
        jobs.append(lambda: services.sync_slot_status(gate.slots[9].pk, SlotStatus.OCCUPIED))
        jobs.append(lambda: services.detect_overstays(now=gate.now))
        jobs.append(lambda: services.mark_no_shows(now=gate.now))

        results = run_parallel(jobs)

        unexpected = [r for ok, r in results if not ok and not isinstance(r, ApiError)]
        assert not unexpected, unexpected  # no OperationalError("deadlock detected"), no hangs
        # PostgreSQL may still pick a victim in a rare cycle: that is the documented, retryable
        # 503 serialization_retry. A lock wait that RAN OUT (lock_timeout) means a real queue /
        # deadlock-by-wait and must fail the build.
        assert not [r for ok, r in results if not ok and code_of(r) == "lock_timeout"]
        assert_counters_exact(gate)


# --- the database itself is the last guard ----------------------------------------------------


class TestSchema:
    def test_a_walk_in_period_is_protected_by_the_exclude_constraint(self):
        gate = make_gate(slots=1)
        walkin.register_walk_in(
            operator=gate.operator, slot_id=gate.slot.pk, plate_number="01A777BC", now=gate.now
        )
        driver = make_user("DRIVER")

        with pytest.raises(IntegrityError) as info, transaction.atomic():
            make_booking(
                user=driver,
                slot=gate.slot,
                vehicle=make_vehicle(driver),
                start=gate.now + timedelta(hours=1),
                end=gate.now + timedelta(hours=2),
                status=S.CONFIRMED,
            )

        assert info.value.__cause__.diag.constraint_name == "booking_no_overlap"

    def test_an_online_booking_cannot_lose_its_user_or_vehicle(self):
        gate = make_gate(slots=1)
        booking = booked(gate)

        with pytest.raises(IntegrityError) as info, transaction.atomic():
            Booking.objects.filter(pk=booking.pk).update(user=None)

        assert info.value.__cause__.diag.constraint_name == "booking_online_has_user_vehicle"

    def test_overstay_columns_are_constrained(self):
        gate = make_gate(slots=1)
        booking = booked(gate)

        with pytest.raises(IntegrityError), transaction.atomic():
            Booking.objects.filter(pk=booking.pk).update(overstay_status="due", overstay_amount=0)

        with pytest.raises(IntegrityError), transaction.atomic():
            Booking.objects.filter(pk=booking.pk).update(overstay_status="bogus")

    def test_the_active_assignment_index_is_partial_unique(self):
        gate = make_gate(slots=1)
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'operator_assignment_unique_active'"
            )
            definition = cursor.fetchone()[0]
        assert "UNIQUE" in definition and "revoked_at IS NULL" in definition
        assert gate.operator.operator_assignments.count() == 1


# --- staff invitations ------------------------------------------------------------------------


class TestInvitations:
    def test_fifty_accounts_race_for_one_code_exactly_one_wins(self):
        from apps.operators import services as operator_services
        from apps.parking.models import OperatorAssignment, OperatorInvite

        gate = make_gate(slots=1)
        _invite, code = operator_services.create_invite(lot=gate.lot, actor=gate.owner)
        people = [make_user("DRIVER") for _ in range(PARALLEL)]

        results = run_parallel(
            [lambda u=u: operator_services.accept_invite(user=u, code=code) for u in people]
        )

        winners = [r for ok, r in results if ok]
        assert len(winners) == 1
        for ok, error in results:
            if not ok:
                assert code_of(error) == "invite_invalid"  # every loser got the same answer
        assert OperatorInvite.objects.get().used_by_id in {p.id for p in people}
        assert (
            OperatorAssignment.objects.filter(revoked_at__isnull=True)
            .exclude(operator=gate.operator)
            .count()
            == 1
        )

    def test_one_account_accepting_the_same_code_in_parallel_is_assigned_once(self):
        from apps.operators import services as operator_services
        from apps.parking.models import OperatorAssignment

        gate = make_gate(slots=1)
        _invite, code = operator_services.create_invite(lot=gate.lot, actor=gate.owner)
        person = make_user("DRIVER")

        results = run_parallel(
            [lambda: operator_services.accept_invite(user=person, code=code) for _ in range(20)]
        )

        assert sum(1 for ok, _ in results if ok) == 1
        assert OperatorAssignment.objects.filter(operator=person).count() == 1

    def test_accepting_versus_revoking_the_invitation(self):
        from apps.operators import services as operator_services
        from apps.parking.models import OperatorInvite

        gate = make_gate(slots=1)
        invite, code = operator_services.create_invite(lot=gate.lot, actor=gate.owner)
        person = make_user("DRIVER")

        results = run_parallel(
            [
                lambda: operator_services.accept_invite(user=person, code=code),
                lambda: operator_services.revoke_invite(
                    lot=gate.lot, invite_id=invite.pk, actor=gate.owner
                ),
            ]
        )

        row = OperatorInvite.objects.get(pk=invite.pk)
        accepted = results[0][0]
        assert results[1][0]  # revoking never fails
        assert accepted == (row.used_at is not None)
        assert not (row.used_at and row.revoked_at)  # CHECK: never both

    def test_a_lot_cannot_be_suspended_under_an_accepting_user(self):
        from apps.operators import services as operator_services

        gate = make_gate(slots=1)
        _invite, code = operator_services.create_invite(lot=gate.lot, actor=gate.owner)
        person = make_user("DRIVER")
        admin = make_user("ADMIN")
        from apps.parking import services as parking_services

        results = run_parallel(
            [
                lambda: operator_services.accept_invite(user=person, code=code),
                lambda: parking_services.change_lot_status(
                    lot=gate.lot, actor=admin, action="suspend"
                ),
            ]
        )

        assert results[1][0]
        assert all(ok or code_of(r) == "invite_invalid" for ok, r in results)


# --- migrations -------------------------------------------------------------------------------


class TestMigrations:
    def test_reversing_0005_is_refused_with_a_clear_message_while_walk_ins_exist(self):
        from django.core.management import call_command

        gate = make_gate(slots=1)
        walkin.register_walk_in(
            operator=gate.operator,
            slot_id=gate.slot.pk,
            plate_number="01A777BC",
            vehicle_type="CAR",
            now=gate.now,
        )

        with pytest.raises(RuntimeError, match="walk-in"):
            call_command("migrate", "bookings", "0004", verbosity=0)
        call_command("migrate", verbosity=0)  # back to the latest state for the other tests

    def test_the_new_checks_are_validated_constraints(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT conname, convalidated FROM pg_constraint WHERE conname IN "
                "('booking_online_has_user_vehicle', 'booking_kind_valid', "
                "'booking_overstay_valid')"
            )
            rows = dict(cursor.fetchall())
        assert rows == {
            "booking_online_has_user_vehicle": True,
            "booking_kind_valid": True,
            "booking_overstay_valid": True,
        }

    def test_user_and_vehicle_columns_are_nullable_and_keep_their_foreign_keys(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'bookings_booking' AND column_name IN ('user_id', 'vehicle_id')"
            )
            nullable = dict(cursor.fetchall())
            cursor.execute(
                "SELECT count(*) FROM pg_constraint WHERE conrelid = 'bookings_booking'::regclass "
                "AND contype = 'f' AND conkey && ARRAY(SELECT attnum FROM pg_attribute "
                "WHERE attrelid = 'bookings_booking'::regclass "
                "AND attname IN ('user_id', 'vehicle_id'))"
            )
            foreign_keys = cursor.fetchone()[0]
        assert nullable == {"user_id": "YES", "vehicle_id": "YES"}
        assert foreign_keys >= 2


class TestAuditTrigger:
    """The PostgreSQL trigger of apps/audit/migrations/0002 refuses what the model refuses."""

    def make_row(self):
        from apps.parking.services import audit

        user = make_user("DRIVER")
        audit(actor=user, action="booking.create", obj_id=uuid.uuid4(), before={}, after={})
        return user

    def test_raw_updates_are_refused(self):
        from django.db import DatabaseError

        self.make_row()

        with pytest.raises(DatabaseError, match="append-only"), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("UPDATE audit_auditlog SET action = 'tampered'")

    def test_raw_deletes_are_refused_outside_the_purge(self):
        from django.db import DatabaseError

        self.make_row()

        with pytest.raises(DatabaseError, match="retention purge"), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM audit_auditlog")

    def test_the_purge_may_delete_and_deleting_an_account_may_null_the_actor(self):
        from apps.audit import services as audit_services
        from apps.audit.models import AuditLog

        user = self.make_row()
        user.delete()  # ON DELETE SET NULL: the one UPDATE the trigger allows
        assert AuditLog.objects.get().actor_id is None

        assert audit_services.purge(now=timezone.now() + timedelta(days=4000)) == 1
        assert AuditLog.objects.count() == 0
