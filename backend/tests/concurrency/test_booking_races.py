"""Booking races against real PostgreSQL (EXCLUDE constraints, row locks). Skipped locally,
mandatory in CI (REQUIRE_POSTGIS=1).

Complements tests/bookings/test_postgis.py (identical-period races) with:
  * partially overlapping and back-to-back periods fired at one slot,
  * the vehicle_plate exclusion (booking_vehicle_no_overlap) raced through the service AND raw,
  * a REAL deadlock (two transactions locking two slots in opposite order) going through the
    service layer's retry wrapper,
  * the documented lot -> slot lock order held under create / status-sync contention.
"""

import threading
from datetime import timedelta

import pytest
from django.db import IntegrityError, OperationalError, connection, transaction
from django.utils import timezone

from apps.bookings import services
from apps.bookings.errors import NoSlotAvailable
from apps.bookings.fields import make_period
from apps.bookings.models import Booking
from apps.core.exceptions import ApiError
from apps.parking.models import Slot, SlotStatus
from tests.bookings.factories import make_vehicle, make_world
from tests.helpers import make_user
from tests.operators.parallel import run_parallel

pytestmark = [pytest.mark.postgis, pytest.mark.django_db(transaction=True)]

PARALLEL = 50
LIVE = ("PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "OVERSTAY")


def base_time():
    return timezone.now().replace(second=0, microsecond=0) + timedelta(hours=2)


def people(n):
    result = []
    for _ in range(n):
        user = make_user("DRIVER")
        result.append((user, make_vehicle(user)))
    return result


def book(world, user, vehicle, start, end, now):
    return lambda: services.create_booking(
        user=user,
        lot_id=world.lot.pk,
        slot_type="STANDARD",
        vehicle=vehicle,
        start=start,
        end=end,
        now=now,
    )


def is_clean_loss(error):
    """Lost the race the documented way: a 409 from the service."""
    return isinstance(error, NoSlotAvailable) or (
        isinstance(error, ApiError) and error.status_code == 409
    )


def assert_no_overlap_in_database():
    rows = list(
        Booking.objects.filter(status__in=LIVE).values_list("slot_id", "starts_at", "ends_at")
    )
    for i, (slot_a, start_a, end_a) in enumerate(rows):
        for slot_b, start_b, end_b in rows[i + 1 :]:
            if slot_a == slot_b:
                assert end_a <= start_b or end_b <= start_a, "two live bookings overlap on a slot"


class TestOverlappingPeriodsOnOneSlot:
    def test_staggered_periods_never_overlap(self):
        now = timezone.now().replace(second=0, microsecond=0)
        start = base_time()
        world = make_world(slots=1)
        # offsets 0/30/60/90 min, each 60 min long: at most two of them (0+60, 0+90, 30+90) fit
        jobs = []
        for n, (user, vehicle) in enumerate(people(PARALLEL)):
            begin = start + timedelta(minutes=30 * (n % 4))
            jobs.append(book(world, user, vehicle, begin, begin + timedelta(hours=1), now))
        results = run_parallel(jobs)
        winners = [r for ok, r in results if ok]
        losers = [r for ok, r in results if not ok]
        assert 1 <= len(winners) <= 2, len(winners)
        assert all(is_clean_loss(e) for e in losers), losers
        assert Booking.objects.count() == len(winners)
        assert_no_overlap_in_database()

    def test_back_to_back_periods_all_win(self):
        now = timezone.now().replace(second=0, microsecond=0)
        start = base_time()
        world = make_world(slots=1)
        jobs = []
        for n, (user, vehicle) in enumerate(people(8)):
            begin = start + timedelta(
                hours=n
            )  # half-open ranges: [0,1) [1,2) ... touch, never overlap
            jobs.append(book(world, user, vehicle, begin, begin + timedelta(hours=1), now))
        results = run_parallel(jobs)
        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        assert Booking.objects.count() == 8
        assert_no_overlap_in_database()


class TestVehiclePlateExclusion:
    """One physical car (plate) cannot hold two slots at once, even under several accounts."""

    def test_same_plate_under_many_accounts_wins_exactly_once_through_the_service(self):
        now = timezone.now().replace(second=0, microsecond=0)
        start = base_time()
        world = make_world(slots=PARALLEL)  # plenty of slots: only the plate can stop them
        plate = "01Z777ZZ"
        twins = []
        for _ in range(PARALLEL):
            user = make_user("DRIVER")
            twins.append((user, make_vehicle(user, plate=plate)))
        jobs = [book(world, u, v, start, start + timedelta(hours=1), now) for u, v in twins]
        results = run_parallel(jobs)
        winners = [r for ok, r in results if ok]
        losers = [r for ok, r in results if not ok]
        assert len(winners) == 1, len(winners)
        for error in losers:
            assert isinstance(error, ApiError), error
            assert str(error.detail["code"]) == "vehicle_busy", error.detail
        assert Booking.objects.filter(vehicle_plate=plate).count() == 1

    def test_raw_inserts_with_one_plate_on_different_slots_leave_one_survivor(self):
        start = base_time()
        world = make_world(slots=PARALLEL)
        plate = "01Y888YY"

        def insert(slot, user, vehicle):
            def run():
                with transaction.atomic():
                    Booking(
                        user=user,
                        slot=slot,
                        vehicle=vehicle,
                        vehicle_plate=plate,
                        period=make_period(start, start + timedelta(hours=1)),
                        amount=1,
                    ).save(force_insert=True)

            return run

        jobs = []
        for slot in world.slots:
            user = make_user("DRIVER")
            jobs.append(insert(slot, user, make_vehicle(user, plate=plate)))
        results = run_parallel(jobs)
        assert sum(1 for ok, _ in results if ok) == 1
        for ok, error in results:
            if ok:
                continue
            # 23P01 = exclusion violation; PostgreSQL may also pick a colliding writer as a
            # deadlock victim (40P01). Both mean "you lost"; anything else is a bug.
            assert isinstance(error, IntegrityError | OperationalError), error
            assert error.__cause__.sqlstate in ("23P01", "40P01"), error.__cause__.sqlstate
            if error.__cause__.sqlstate == "23P01":
                assert error.__cause__.diag.constraint_name == "booking_vehicle_no_overlap"
        assert Booking.objects.filter(vehicle_plate=plate).count() == 1


class TestRealDeadlockRetry:
    """Two transactions take two slot locks in OPPOSITE order: PostgreSQL really raises 40P01 for
    one of them. ``services.retrying`` (the wrapper every booking write uses) must repeat that
    transaction once and both must finish."""

    def _worker(self, first, second, both_hold_first, attempts):
        @services.retrying
        @transaction.atomic
        def work():
            attempts.append(1)
            Slot.objects.select_for_update().get(pk=first)
            if len(attempts) == 1:
                both_hold_first.wait(timeout=30)  # make the cycle certain on the first attempt
            Slot.objects.select_for_update().get(pk=second)
            return "done"

        return work

    def test_a_genuine_deadlock_is_retried_once_and_both_sides_finish(self):
        world = make_world(slots=2)
        a, b = world.slots[0].pk, world.slots[1].pk
        both_hold_first = threading.Barrier(2)
        attempts_one, attempts_two = [], []
        results = run_parallel(
            [
                self._worker(a, b, both_hold_first, attempts_one),
                self._worker(b, a, both_hold_first, attempts_two),
            ]
        )
        assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
        assert [r for _ok, r in results] == ["done", "done"]
        # first attempts: 2; the deadlock victim ran a second time; the survivor never did
        assert len(attempts_one) + len(attempts_two) == 3, (len(attempts_one), len(attempts_two))

    def test_a_lock_timeout_is_a_retryable_503_on_real_postgres(self):
        """Another transaction holds a slot lock for good: the waiting write hits the lock
        timeout (55P03) and the wrapper turns it into the documented 503 lock_timeout."""
        world = make_world(slots=1)
        slot_id = world.slots[0].pk
        holder_ready, release = threading.Event(), threading.Event()

        def holder():
            try:
                with transaction.atomic():
                    Slot.objects.select_for_update().get(pk=slot_id)
                    holder_ready.set()
                    release.wait(timeout=60)
            finally:
                connection.close()

        thread = threading.Thread(target=holder)
        thread.start()
        assert holder_ready.wait(timeout=30)

        @services.retrying
        @transaction.atomic
        def waiting_writer():
            with connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout = '500ms'")
            Slot.objects.select_for_update().get(pk=slot_id)

        try:
            with pytest.raises(ApiError) as info:
                waiting_writer()
        finally:
            release.set()
            thread.join(timeout=60)
        assert info.value.status_code == 503
        assert str(info.value.detail["code"]) == "lock_timeout"


class TestLockOrderUnderContention:
    def test_create_booking_vs_slot_status_sync_never_deadlock(self):
        """Booking writers lock lot -> slot; sync_slot_status must use the same order. Hammer both."""
        now = timezone.now().replace(second=0, microsecond=0)
        start = base_time()
        world = make_world(slots=4)

        def creator(user, vehicle, n):
            begin = start + timedelta(hours=2 * n)
            return book(world, user, vehicle, begin, begin + timedelta(hours=1), now)

        def syncer(slot, status):
            return lambda: services.sync_slot_status(slot.pk, status)

        jobs = []
        for n, (user, vehicle) in enumerate(people(20)):
            jobs.append(creator(user, vehicle, n % 6))
            jobs.append(
                syncer(world.slots[n % 4], SlotStatus.OCCUPIED if n % 2 else SlotStatus.FREE)
            )
        results = run_parallel(jobs)
        unexpected = [
            r
            for ok, r in results
            if not ok and not is_clean_loss(r) and not isinstance(r, ApiError)
        ]
        assert not unexpected, unexpected  # no raw OperationalError("deadlock detected")
        assert_no_overlap_in_database()
