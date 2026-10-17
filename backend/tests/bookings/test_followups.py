"""Second review round: deadlock retry, plate-wide vehicle exclusivity, expired holds in the
vehicle check, OVERSTAY keeps its slot, migration safety net."""

from datetime import timedelta
from unittest import mock

import pytest
from django.conf import settings as django_settings
from django.db import OperationalError

from apps.bookings import migration_checks, selectors, services, sweeps
from apps.bookings.errors import SerializationRetry
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError, NotFoundError
from tests.bookings.factories import FakePgError, make_booking, make_vehicle, make_world
from tests.helpers import make_user

pytestmark = pytest.mark.django_db

WINDOW = timedelta(minutes=15)


def code_of(info):
    return str(info.value.detail["code"])


def at(now, start_h, length_h=1):
    return now + timedelta(hours=start_h), now + timedelta(hours=start_h + length_h)


def deadlock():
    error = OperationalError("deadlock detected")
    error.__cause__ = FakePgError("40P01")
    return error


@pytest.fixture(autouse=True)
def _no_sleep():
    with mock.patch.object(services.time, "sleep"):
        yield


def book(world, user, vehicle, window, now):
    return services.create_booking(
        user=user,
        lot_id=world.lot.pk,
        slot_type="STANDARD",
        vehicle=vehicle,
        start=window[0],
        end=window[1],
        now=now,
    )


class TestDeadlockRetry:
    def test_create_retries_once_and_succeeds(self, driver, vehicle, now):
        world = make_world(slots=2)
        real = services._lock_lot
        with mock.patch.object(services, "_lock_lot", side_effect=[deadlock(), real(world.lot.pk)]):
            booking = book(world, driver, vehicle, at(now, 1), now)
        assert booking.pk
        services.time.sleep.assert_called_once()  # a small jitter between the attempts

    def test_create_gives_up_after_one_retry_with_a_503(self, driver, vehicle, now):
        world = make_world(slots=2)
        with mock.patch.object(services, "_lock_lot", side_effect=deadlock()) as lock:
            with pytest.raises(SerializationRetry) as info:
                book(world, driver, vehicle, at(now, 1), now)
        assert lock.call_count == 2
        assert info.value.status_code == 503
        assert code_of(info) == "serialization_retry"

    def test_other_operational_errors_are_not_retried(self, driver, vehicle, now):
        world = make_world(slots=2)
        with mock.patch.object(services, "_lock_lot", side_effect=OperationalError("disk")) as lock:
            with pytest.raises(OperationalError):
                book(world, driver, vehicle, at(now, 1), now)
        assert lock.call_count == 1

    def test_cancel_is_retried_too(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=3),
            end=now + timedelta(hours=4),
            status=S.CONFIRMED,
        )
        real = services._lock_lot
        with mock.patch.object(services, "_lock_lot", side_effect=[deadlock(), real(world.lot.pk)]):
            cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.status == S.CANCELLED

    def test_extend_is_retried_too(self, driver, vehicle, now, settings):
        settings.BOOKING_EXTEND_ENABLED = True
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=3),
            end=now + timedelta(hours=4),
            status=S.CONFIRMED,
        )
        with mock.patch.object(services, "_lock_lot", side_effect=deadlock()):
            with pytest.raises(SerializationRetry):
                services.extend_booking(
                    booking_id=booking.pk,
                    user=driver,
                    new_end=booking.ends_at + timedelta(hours=1),
                    now=now,
                )

    def test_system_transitions_are_retried_and_then_isolated_by_the_batch(
        self, driver, vehicle, now
    ):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            hold_expires_at=now - timedelta(minutes=1),
        )
        real = services._lock_lot
        with mock.patch.object(services, "_lock_lot", side_effect=[deadlock(), real(world.lot.pk)]):
            assert services.expire_hold(booking.pk, now=now) is True
        assert Booking.objects.get(pk=booking.pk).status == S.EXPIRED

    def test_a_lock_timeout_is_not_retried(self, driver, vehicle, now):
        world = make_world(slots=1)
        timeout = OperationalError("lock timeout")
        timeout.__cause__ = FakePgError("55P03")
        with mock.patch.object(services, "_lock_lot", side_effect=timeout) as lock:
            with pytest.raises(ApiError) as info:
                book(world, driver, vehicle, at(now, 1), now)
        assert lock.call_count == 1
        assert code_of(info) == "lock_timeout"


class TestVehicleIsIdentifiedByItsPlate:
    def test_the_same_plate_under_two_accounts_cannot_hold_two_slots(self, now):
        world = make_world(slots=3)
        a, b = make_user("DRIVER"), make_user("DRIVER")
        car_a = make_vehicle(a, plate="01A777AA")
        car_b = make_vehicle(b, plate="01A777AA")  # same plate, different account: allowed
        book(world, a, car_a, at(now, 1, 2), now)
        with pytest.raises(ApiError) as info:
            book(world, b, car_b, at(now, 2, 2), now)
        assert info.value.status_code == 409
        assert code_of(info) == "vehicle_busy"

    def test_back_to_back_with_the_same_plate_is_fine(self, now):
        world = make_world(slots=3)
        a, b = make_user("DRIVER"), make_user("DRIVER")
        book(world, a, make_vehicle(a, plate="01A777AA"), at(now, 1), now)
        assert book(world, b, make_vehicle(b, plate="01A777AA"), at(now, 2), now)

    def test_a_different_plate_is_independent(self, now):
        world = make_world(slots=3)
        a, b = make_user("DRIVER"), make_user("DRIVER")
        book(world, a, make_vehicle(a, plate="01A777AA"), at(now, 1), now)
        assert book(world, b, make_vehicle(b, plate="01A888AA"), at(now, 1), now)

    def test_the_check_works_across_lots(self, now):
        first, second = make_world(slots=1), make_world(slots=1)
        a, b = make_user("DRIVER"), make_user("DRIVER")
        book(first, a, make_vehicle(a, plate="01A777AA"), at(now, 1), now)
        with pytest.raises(ApiError):
            book(second, b, make_vehicle(b, plate="01A777AA"), at(now, 1), now)

    def test_the_snapshot_plate_is_what_counts_not_a_later_edit(self, now):
        from apps.vehicles.models import Vehicle

        world = make_world(slots=3)
        a = make_user("DRIVER")
        car = make_vehicle(a, plate="01A777AA")
        book(world, a, car, at(now, 1, 2), now)
        Vehicle.objects.filter(pk=car.pk).update(plate_number="01B000BB")
        car.refresh_from_db()
        with pytest.raises(ApiError):  # the live booking still belongs to plate 01A777AA
            other = make_user("DRIVER")
            book(world, other, make_vehicle(other, plate="01A777AA"), at(now, 2), now)

    def test_expired_unpaid_holds_do_not_make_a_plate_busy(self, now):
        world = make_world(slots=1)
        a = make_user("DRIVER")
        car = make_vehicle(a, plate="01A777AA")
        make_booking(
            user=a,
            slot=world.slots[0],
            vehicle=car,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            hold_expires_at=now - timedelta(minutes=1),
        )
        assert not selectors.vehicle_has_overlap("01A777AA", *at(now, 1), now=now)

    def test_live_holds_still_make_it_busy(self, now):
        world = make_world(slots=1)
        a = make_user("DRIVER")
        make_booking(
            user=a,
            slot=world.slots[0],
            vehicle=make_vehicle(a, plate="01A777AA"),
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            hold_expires_at=now + timedelta(minutes=5),
        )
        assert selectors.vehicle_has_overlap("01A777AA", *at(now, 1), now=now)

    def test_create_ignores_the_same_cars_expired_hold_in_another_lot(self, now):
        first, second = make_world(slots=1), make_world(slots=1)
        a = make_user("DRIVER")
        car = make_vehicle(a, plate="01A777AA")
        make_booking(
            user=a,
            slot=first.slots[0],
            vehicle=car,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            hold_expires_at=now - timedelta(minutes=1),
        )
        assert book(second, a, car, at(now, 1), now)


class TestOverstayKeepsTheSlot:
    @pytest.fixture
    def overstaying(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now - timedelta(hours=3),
            end=now - timedelta(minutes=30),
            status=S.OVERSTAY,
        )
        return world, booking

    def test_the_slot_is_not_offered_again_while_the_car_is_still_there(self, overstaying, now):
        from apps.bookings.errors import NoSlotAvailable

        world, _ = overstaying
        other = make_user("DRIVER")
        with pytest.raises(NoSlotAvailable):
            book(world, other, make_vehicle(other), at(now, 1), now)

    def test_availability_counts_agree(self, overstaying, now):
        world, _ = overstaying
        start, end = at(now, 1)
        pool = selectors.build_pool(
            world.lot.pk, "STANDARD", start, end, now=now, immediate_window=WINDOW
        )
        counts = selectors.count_availability(
            world.lot.pk, "STANDARD", start, end, now=now, immediate_window=WINDOW
        )
        assert (pool.total, pool.available) == counts == (1, 0)

    def test_slot_has_overlap_sees_it(self, overstaying, now):
        world, booking = overstaying
        assert selectors.slot_has_overlap(world.slots[0].pk, *at(now, 5))
        assert not selectors.slot_has_overlap(
            world.slots[0].pk, *at(now, 5), exclude_booking_id=booking.pk
        )

    def test_bookings_that_end_before_the_overstay_began_are_unaffected(self, overstaying, now):
        world, booking = overstaying
        assert not selectors.slot_has_overlap(
            world.slots[0].pk, booking.starts_at - timedelta(hours=2), booking.starts_at
        )

    def test_the_slot_is_free_again_after_check_out(self, overstaying, driver, now):
        from apps.bookings.state import status_write_allowed

        world, booking = overstaying
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=S.COMPLETED)
        other = make_user("DRIVER")
        assert book(world, other, make_vehicle(other), at(now, 1), now)

    def test_the_vehicle_stays_busy_too(self, overstaying, vehicle, now):
        assert selectors.vehicle_has_overlap(vehicle.plate_number, *at(now, 2), now=now)


class TestMigrationSafetyNet:
    def test_overlapping_live_bookings_of_one_plate_are_reported_not_ignored(self, now):
        world = make_world(slots=2)
        a, b = make_user("DRIVER"), make_user("DRIVER")
        one = make_booking(
            user=a,
            slot=world.slots[0],
            vehicle=make_vehicle(a, plate="01A777AA"),
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=3),
            status=S.CONFIRMED,
        )
        two = make_booking(
            user=b,
            slot=world.slots[1],
            vehicle=make_vehicle(b, plate="01A777AA"),
            start=now + timedelta(hours=2),
            end=now + timedelta(hours=4),
            status=S.CONFIRMED,
        )
        with pytest.raises(RuntimeError) as info:
            migration_checks.assert_no_vehicle_overlaps(Booking, key="vehicle_plate")
        message = str(info.value)
        assert str(one.pk) in message and str(two.pk) in message

    def test_clean_data_passes(self, now):
        world = make_world(slots=2)
        a = make_user("DRIVER")
        car = make_vehicle(a, plate="01A777AA")
        make_booking(
            user=a,
            slot=world.slots[0],
            vehicle=car,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            status=S.CONFIRMED,
        )
        make_booking(
            user=a,
            slot=world.slots[1],
            vehicle=car,
            start=now + timedelta(hours=2),
            end=now + timedelta(hours=3),
            status=S.CONFIRMED,
        )
        make_booking(  # cancelled ones may overlap
            user=a,
            slot=world.slots[1],
            vehicle=car,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=3),
            status=S.CANCELLED,
        )
        migration_checks.assert_no_vehicle_overlaps(Booking, key="vehicle_plate")


class TestTimeoutSettings:
    def test_test_settings_give_the_lock_queue_room(self):
        """50 users queue on one lot lock: the per-request 5 s ceiling must not be the limit."""
        assert django_settings.BOOKING_LOCK_TIMEOUT_SECONDS >= 30

    def test_sweeps_use_their_own_short_timeouts(self):
        assert sweeps.SWEEP_LOCK_TIMEOUT_SECONDS < sweeps.SWEEP_STATEMENT_TIMEOUT_SECONDS


def test_unknown_booking_is_still_not_found_after_the_retry_wrapper(driver, now):
    import uuid

    with pytest.raises(NotFoundError):
        services.cancel_booking(booking_id=uuid.uuid4(), user=driver, now=now)
