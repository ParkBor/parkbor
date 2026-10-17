"""Real PostgreSQL behaviour: EXCLUDE constraint, row locks, parallel requests (CI only).

Row locks and range constraints do not exist on SQLite, so these tests are skipped locally
(`postgis` marker, see tests/conftest.py) and MUST run in CI (REQUIRE_POSTGIS=1).
"""

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest import mock

import pytest
from django.db import IntegrityError, OperationalError, connection, transaction
from django.utils import timezone

from apps.bookings import services
from apps.bookings.errors import BookingConflict, NoSlotAvailable
from apps.bookings.fields import make_period
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError
from apps.parking.models import ParkingLot, Slot, SlotStatus
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import client_for, make_user

pytestmark = [pytest.mark.postgis, pytest.mark.django_db(transaction=True)]

PARALLEL = 50


def window():
    now = timezone.now().replace(second=0, microsecond=0)
    return now, now + timedelta(hours=1), now + timedelta(hours=3)


RESULT_TIMEOUT_SECONDS = 90


@pytest.fixture(autouse=True)
def _generous_throttles(monkeypatch):
    """Fifty requests in a burst are the point of these tests: lift the per-minute limits.
    (The 10/min limit itself is covered by tests/bookings/test_api.py.)"""
    from rest_framework.throttling import SimpleRateThrottle

    rates = {**SimpleRateThrottle.THROTTLE_RATES}
    for scope in ("booking_create", "booking_mutate", "booking_qr", "booking_quote", "user"):
        rates[scope] = "100000/min"
    monkeypatch.setattr(SimpleRateThrottle, "THROTTLE_RATES", rates)


def run_parallel(jobs, workers=None):
    """Run callables at the same instant (one thread, one DB connection each).

    Returns [(ok, result_or_exception)]. The pool is abandoned, not joined, if something hangs:
    ``f.result(timeout=...)`` raises and ``shutdown(wait=False, cancel_futures=True)`` frees the
    test run (the DB ``lock_timeout``/``statement_timeout`` of the test settings end the hung
    statements).
    """
    workers = workers or len(jobs)
    barrier = threading.Barrier(len(jobs))

    def wrap(job):
        def run():
            try:
                barrier.wait(timeout=30)
                return True, job()
            except BaseException as exc:  # noqa: BLE001 - reported to the assertions
                return False, exc
            finally:
                connection.close()

        return run

    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = [pool.submit(wrap(job)) for job in jobs]
        return [f.result(timeout=RESULT_TIMEOUT_SECONDS) for f in futures]
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


class TestSchema:
    def test_btree_gist_extension_and_exclusion_constraint_exist(self):
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'")
            assert cursor.fetchone()
            cursor.execute("SELECT contype FROM pg_constraint WHERE conname = 'booking_no_overlap'")
            assert cursor.fetchone() == ("x",)
            cursor.execute("SELECT 1 FROM pg_constraint WHERE conname = 'booking_period_valid'")
            assert cursor.fetchone()

    def test_slot_fk_is_protect_at_the_database_level(self):
        # ON DELETE NO ACTION / RESTRICT: raw deletes of a booked slot must fail too.
        _now, start, end = window()
        world = make_world(slots=1)
        user = make_user("DRIVER")
        make_booking(
            user=user, slot=world.slots[0], vehicle=make_vehicle(user), start=start, end=end
        )
        with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("DELETE FROM parking_slot WHERE id = %s", [world.slots[0].pk])


class TestExclusionConstraint:
    def setup_method(self):
        self.now, self.start, self.end = window()
        self.world = make_world(slots=2)
        self.user = make_user("DRIVER")
        self.vehicle = make_vehicle(self.user)

    def book(self, slot, start, end, status=S.CONFIRMED):
        return make_booking(
            user=self.user, slot=slot, vehicle=self.vehicle, start=start, end=end, status=status
        )

    def test_overlapping_live_bookings_on_one_slot_are_refused_by_the_database(self):
        slot = self.world.slots[0]
        self.book(slot, self.start, self.end)
        with pytest.raises(IntegrityError), transaction.atomic():
            self.book(slot, self.start + timedelta(minutes=30), self.end + timedelta(hours=1))

    def test_adjacent_periods_are_fine_because_the_range_is_half_open(self):
        slot = self.world.slots[0]
        self.book(slot, self.start, self.end)
        self.book(slot, self.end, self.end + timedelta(hours=1))
        self.book(slot, self.start - timedelta(hours=1), self.start)

    def test_the_same_period_on_another_slot_is_fine(self):
        self.book(self.world.slots[0], self.start, self.end)
        self.book(self.world.slots[1], self.start, self.end)

    @pytest.mark.parametrize("status", [S.CANCELLED, S.EXPIRED, S.COMPLETED, S.NO_SHOW])
    def test_finished_bookings_do_not_block(self, status):
        slot = self.world.slots[0]
        self.book(slot, self.start, self.end, status=status)
        self.book(slot, self.start, self.end)

    @pytest.mark.parametrize("status", [S.PENDING_PAYMENT, S.CONFIRMED, S.ACTIVE, S.OVERSTAY])
    def test_every_live_status_blocks(self, status):
        slot = self.world.slots[0]
        self.book(slot, self.start, self.end, status=status)
        with pytest.raises(IntegrityError), transaction.atomic():
            self.book(slot, self.start, self.end)

    def test_extending_into_another_booking_is_refused_by_the_database(self):
        slot = self.world.slots[0]
        first = self.book(slot, self.start, self.end)
        self.book(slot, self.end + timedelta(minutes=30), self.end + timedelta(hours=2))
        first.period = make_period(self.start, self.end + timedelta(hours=1))
        with pytest.raises(IntegrityError), transaction.atomic():
            first.save(update_fields=["period"])

    def test_check_constraint_rejects_scalars_that_disagree_with_the_range(self):
        booking = self.book(self.world.slots[0], self.start, self.end)
        with pytest.raises(IntegrityError), transaction.atomic():
            Booking.objects.filter(pk=booking.pk).update(ends_at=self.end + timedelta(hours=1))

    def test_one_vehicle_cannot_hold_two_slots_at_once_in_the_database(self):
        self.book(self.world.slots[0], self.start, self.end)
        with pytest.raises(IntegrityError) as info, transaction.atomic():
            self.book(self.world.slots[1], self.start + timedelta(minutes=30), self.end)
        assert info.value.__cause__.sqlstate == "23P01"
        assert info.value.__cause__.diag.constraint_name == "booking_vehicle_no_overlap"

    def test_the_same_plate_under_two_accounts_is_one_car_for_the_database(self):
        other = make_user("DRIVER")
        twin = make_vehicle(other, plate=self.vehicle.plate_number)
        self.book(self.world.slots[0], self.start, self.end)
        with pytest.raises(IntegrityError) as info, transaction.atomic():
            make_booking(
                user=other,
                slot=self.world.slots[1],
                vehicle=twin,
                start=self.start + timedelta(minutes=30),
                end=self.end,
            )
        assert info.value.__cause__.diag.constraint_name == "booking_vehicle_no_overlap"

    def test_btree_gist_indexes_the_varchar_plate_column(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conname = 'booking_vehicle_no_overlap'"
            )
            definition = cursor.fetchone()[0]
        assert "vehicle_plate WITH =" in definition and "period WITH &&" in definition

    def test_service_reports_the_vehicle_constraint_as_vehicle_busy(self):
        self.book(self.world.slots[0], self.start, self.end)
        with mock.patch.object(services.selectors, "vehicle_has_overlap", return_value=False):
            with pytest.raises(ApiError) as info:
                services.create_booking(
                    user=self.user,
                    lot_id=self.world.lot.pk,
                    slot_type="STANDARD",
                    vehicle=self.vehicle,
                    start=self.start + timedelta(minutes=30),
                    end=self.end,
                    now=self.now,
                )
        assert str(info.value.detail["code"]) == "vehicle_busy"

    def test_service_maps_a_database_overlap_to_a_conflict(self, settings):
        settings.BOOKING_EXTEND_ENABLED = True
        slot = self.world.slots[0]
        mine = self.book(slot, self.start, self.end)
        # A booking the overlap pre-check cannot see (inserted by "someone else" after it) is
        # exactly what the constraint is for: blind the pre-check and let the database decide.
        other = make_user("DRIVER")
        make_booking(
            user=other,
            slot=slot,
            vehicle=make_vehicle(other),
            start=self.end,
            end=self.end + timedelta(hours=1),
        )
        with mock.patch.object(services.selectors, "slot_has_overlap", return_value=False):
            with pytest.raises(BookingConflict):
                services.extend_booking(
                    booking_id=mine.pk,
                    user=self.user,
                    new_end=self.end + timedelta(minutes=30),
                    now=self.now,
                )


class TestFiftyParallelRequests:
    """ARCHITECTURE 18: 50 parallel requests for the LAST slot -> exactly one 201, rest 409."""

    def _payload(self, world, vehicle, start, end):
        return {
            "parking_lot_id": str(world.lot.pk),
            "slot_type": "STANDARD",
            "vehicle_id": str(vehicle.pk),
            "start": start.isoformat(),
            "end": end.isoformat(),
        }

    def _fire(self, world, users, start, end):
        jobs = []
        for n, (user, vehicle) in enumerate(users):
            client = client_for(user)
            payload = self._payload(world, vehicle, start, end)
            key = f"parallel-request-{n:04d}-{user.pk}"
            jobs.append(
                lambda c=client, p=payload, k=key: c.post(
                    "/api/v1/bookings", p, format="json", HTTP_IDEMPOTENCY_KEY=k
                )
            )
        return run_parallel(jobs)

    def test_fifty_different_users_one_slot_exactly_one_wins(self):
        _now, start, end = window()
        world = make_world(slots=1)
        users = []
        for _ in range(PARALLEL):
            user = make_user("DRIVER")
            users.append((user, make_vehicle(user)))
        results = self._fire(world, users, start, end)
        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        codes = sorted(res.status_code for _ok, res in results)
        assert codes.count(201) == 1, codes
        assert codes.count(409) == PARALLEL - 1, codes
        assert Booking.objects.count() == 1
        assert {str(r.json()["code"]) for _ok, r in results if r.status_code == 409} == {
            "no_slot_available"
        }

    def test_two_users_share_the_fifty_requests(self):
        _now, start, end = window()
        world = make_world(slots=1)
        users = []
        for _ in range(2):
            user = make_user("DRIVER")
            users.append((user, make_vehicle(user)))
        results = self._fire(world, users * (PARALLEL // 2), start, end)
        assert all(ok for ok, _ in results)
        codes = [res.status_code for _ok, res in results]
        assert len(codes) == PARALLEL
        assert codes.count(201) == 1, codes
        # the rest lose on the slot (409), on the car already booked (409) or on a per-user limit
        assert set(codes) <= {201, 409, 422}, codes
        assert Booking.objects.count() == 1

    def test_with_k_slots_exactly_k_requests_win(self):
        _now, start, end = window()
        world = make_world(slots=7)
        users = []
        for _ in range(PARALLEL):
            user = make_user("DRIVER")
            users.append((user, make_vehicle(user)))
        results = self._fire(world, users, start, end)
        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        codes = [res.status_code for _ok, res in results]
        assert codes.count(201) == 7 and codes.count(409) == PARALLEL - 7, codes
        slots = list(Booking.objects.values_list("slot_id", flat=True))
        assert len(set(slots)) == 7  # never two bookings on one slot

    def test_the_same_idempotency_key_fifty_times_makes_one_booking(self):
        _now, start, end = window()
        world = make_world(slots=3)
        user = make_user("DRIVER")
        vehicle = make_vehicle(user)
        payload = self._payload(world, vehicle, start, end)
        results = run_parallel(
            [
                lambda: client_for(user).post(  # a fresh client per request, like real devices
                    "/api/v1/bookings",
                    payload,
                    format="json",
                    HTTP_IDEMPOTENCY_KEY="one-single-key-for-everyone",
                )
                for _ in range(PARALLEL)
            ]
        )
        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        codes = [res.status_code for _ok, res in results]
        assert Booking.objects.count() == 1
        assert codes.count(201) == 1
        assert set(codes) <= {201, 200, 409}, codes  # 409 = still in progress after the wait


class TestRawExclusionRace:
    """The EXCLUDE constraint itself under a real race: no lot lock, no slot lock, no pre-check.

    This is the layer that must hold even if every application-level rule is bypassed.
    """

    def _people(self, n):
        people = []
        for _ in range(n):
            user = make_user("DRIVER")
            people.append((user, make_vehicle(user)))
        return people

    def test_fifty_unguarded_inserts_exactly_one_survives(self):
        _now, start, end = window()
        world = make_world(slots=1)
        slot = world.slots[0]

        def insert(user, vehicle):
            def run():
                with transaction.atomic():
                    Booking(
                        user=user,
                        slot=slot,
                        vehicle=vehicle,
                        vehicle_plate=vehicle.plate_number,
                        period=make_period(start, end),
                        amount=1,
                    ).save(force_insert=True)

            return run

        results = run_parallel([insert(u, v) for u, v in self._people(PARALLEL)])
        winners = [r for ok, r in results if ok]
        losers = [r for ok, r in results if not ok]
        assert len(winners) == 1
        assert len(losers) == PARALLEL - 1
        # With many colliding writers PostgreSQL may resolve some pairs as a deadlock (40P01,
        # OperationalError) instead of the exclusion violation (23P01, IntegrityError): both mean
        # "you lost", and both are handled by the service layer. Anything else is a bug.
        for error in losers:
            assert isinstance(error, IntegrityError | OperationalError), error
            sqlstate = error.__cause__.sqlstate
            assert sqlstate in ("23P01", "40P01"), sqlstate
            if sqlstate == "23P01":
                assert error.__cause__.diag.constraint_name == "booking_no_overlap"
        assert Booking.objects.count() == 1

    def test_insert_booking_helper_without_the_lot_lock(self):
        """services._insert_booking called by 50 threads with NO lot lock: still one winner, the
        rest see NoSlotAvailable (slot skipped as locked, or EXCLUDE fired)."""
        now, start, end = window()
        world = make_world(slots=1)
        slot = world.slots[0]

        def attempt(user, vehicle):
            def run():
                with transaction.atomic():
                    return services._insert_booking(
                        ranked=[slot.pk],
                        attempts=1,
                        user=user,
                        vehicle=vehicle,
                        vehicle_plate=vehicle.plate_number,
                        period=make_period(start, end),
                        amount=1,
                        hold_expires_at=now + timedelta(minutes=10),
                        qr_nonce="n" * 22,
                    )

            return run

        results = run_parallel([attempt(u, v) for u, v in self._people(PARALLEL)])
        assert sum(1 for ok, _ in results if ok) == 1

        def lost_cleanly(error):  # NoSlotAvailable, or PostgreSQL picked us as deadlock victim
            return isinstance(error, NoSlotAvailable) or (
                isinstance(error, OperationalError) and error.__cause__.sqlstate == "40P01"
            )

        assert all(lost_cleanly(r) for ok, r in results if not ok), [
            r for ok, r in results if not ok
        ]
        assert Booking.objects.count() == 1

    def test_two_slots_never_yield_more_than_two_winners(self):
        now, start, end = window()
        world = make_world(slots=2)

        def attempt(user, vehicle):
            def run():
                with transaction.atomic():
                    return services._insert_booking(
                        ranked=[s.pk for s in world.slots],
                        attempts=2,
                        user=user,
                        vehicle=vehicle,
                        vehicle_plate=vehicle.plate_number,
                        period=make_period(start, end),
                        amount=1,
                        hold_expires_at=now + timedelta(minutes=10),
                        qr_nonce="n" * 22,
                    )

            return run

        results = run_parallel([attempt(u, v) for u, v in self._people(PARALLEL)])
        winners = [r for ok, r in results if ok]
        assert 1 <= len(winners) <= 2
        assert len({b.slot_id for b in winners}) == len(winners)
        assert Booking.objects.count() == len(winners)


class TestSkipLocked:
    def test_a_slot_locked_by_another_transaction_is_skipped_not_waited_for(self):
        now, start, end = window()
        world = make_world(slots=2)
        user = make_user("DRIVER")
        vehicle = make_vehicle(user)
        holder_has_lock, release = threading.Event(), threading.Event()

        def holder():
            with transaction.atomic():
                Slot.objects.select_for_update().get(pk=world.slots[0].pk)
                holder_has_lock.set()
                release.wait(timeout=30)
            connection.close()

        thread = threading.Thread(target=holder)
        thread.start()
        assert holder_has_lock.wait(timeout=30)
        try:
            ((ok, booking),) = run_parallel(
                [
                    lambda: services.create_booking(
                        user=user,
                        lot_id=world.lot.pk,
                        slot_type="STANDARD",
                        vehicle=vehicle,
                        start=start,
                        end=end,
                        now=now,
                    )
                ],
                workers=1,
            )
            assert ok, booking
            assert booking.slot_id == world.slots[1].pk  # best slot was locked -> next one
        finally:
            release.set()
            thread.join(timeout=30)


class TestNoDeadlocks:
    def test_parallel_create_cancel_extend_expire_all_finish(self, settings):
        settings.BOOKING_EXTEND_ENABLED = True
        now, start, end = window()
        world = make_world(slots=6)
        users = [make_user("DRIVER") for _ in range(12)]
        vehicles = [make_vehicle(u) for u in users]
        existing = [
            make_booking(
                user=users[i],
                slot=world.slots[i % 6],
                vehicle=vehicles[i],
                start=start + timedelta(hours=4 * (i // 6)),
                end=end + timedelta(hours=4 * (i // 6)),
                status=S.CONFIRMED if i % 3 else S.PENDING_PAYMENT,
                hold_expires_at=now - timedelta(minutes=1),
            )
            for i in range(12)
        ]
        jobs = []
        for i, booking in enumerate(existing):
            user = users[i]
            if i % 4 == 0:
                jobs.append(
                    lambda b=booking, u=user: services.cancel_booking(
                        booking_id=b.pk, user=u, now=now
                    )
                )
            elif i % 4 == 1:
                jobs.append(
                    lambda b=booking, u=user: services.extend_booking(
                        booking_id=b.pk, user=u, new_end=b.ends_at + timedelta(minutes=30), now=now
                    )
                )
            elif i % 4 == 2:
                jobs.append(lambda b=booking: services.expire_hold(b.pk, now=now))
            else:
                jobs.append(lambda: services.expire_overdue_holds(now=now))
        for _n in range(10):
            user = make_user("DRIVER")
            vehicle = make_vehicle(user)
            jobs.append(
                lambda u=user, v=vehicle: services.create_booking(
                    user=u,
                    lot_id=world.lot.pk,
                    slot_type="STANDARD",
                    vehicle=v,
                    start=start + timedelta(hours=8),
                    end=end + timedelta(hours=8),
                    now=now,
                )
            )
        jobs.append(lambda: services.sync_slot_status(world.slots[0].pk, SlotStatus.OCCUPIED))
        results = run_parallel(jobs)
        unexpected = [
            r for ok, r in results if not ok and not isinstance(r, ApiError | NoSlotAvailable)
        ]
        assert not unexpected, unexpected  # no OperationalError("deadlock detected"), no hangs
        # No two live bookings overlap on a slot, whatever interleaving happened.
        live = list(
            Booking.objects.filter(
                status__in=["PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "OVERSTAY"]
            )
        )
        for a in live:
            for b in live:
                if a.pk < b.pk and a.slot_id == b.slot_id:
                    assert a.ends_at <= b.starts_at or b.ends_at <= a.starts_at

    def test_parallel_slot_status_changes_keep_the_counters_exact(self):
        world = make_world(slots=6)
        jobs = [
            lambda s=slot: services.sync_slot_status(s.pk, SlotStatus.OCCUPIED)
            for slot in world.slots[:4]
        ] + [
            lambda s=slot: services.sync_slot_status(s.pk, SlotStatus.FREE)
            for slot in world.slots[4:]
        ]
        results = run_parallel(jobs, workers=6)
        assert all(ok for ok, _ in results), results
        lot = ParkingLot.objects.get(pk=world.lot.pk)
        assert (lot.total_slots, lot.free_slots) == (6, 2)
