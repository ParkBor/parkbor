"""create_booking: validation, slot choice, pricing, locking, events (ARCHITECTURE 10.3-10.5)."""

import logging
from datetime import time, timedelta
from decimal import Decimal
from unittest import mock

import pytest
from django.test import override_settings

from apps.bookings import services
from apps.bookings.errors import NoSlotAvailable
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import NotFoundError, UnprocessableError
from apps.parking.models import LotStatus, ParkingLot, Slot, SlotStatus, SlotType, Tariff
from tests.bookings.factories import (
    make_booking,
    make_slot,
    make_vehicle,
    make_world,
    pg_integrity_error,
)
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


def code_of(info):
    return str(info.value.detail["code"])


def book(world, user, vehicle, window, now, slot_type="STANDARD", **extra):
    return services.create_booking(
        user=user,
        lot_id=world.lot.pk,
        slot_type=slot_type,
        vehicle=vehicle,
        start=window[0],
        end=window[1],
        now=now,
        **extra,
    )


class TestHappyPath:
    def test_creates_a_pending_booking_with_a_frozen_price(
        self, driver, vehicle, world, window, now
    ):
        booking = book(world, driver, vehicle, window, now)
        fresh = Booking.objects.get(pk=booking.pk)
        assert fresh.status == S.PENDING_PAYMENT
        assert fresh.user == driver
        assert fresh.vehicle == vehicle
        assert fresh.slot in world.slots
        assert (fresh.starts_at, fresh.ends_at) == window
        assert fresh.amount == Decimal("12000.00")  # 2 h * 6000
        assert fresh.refund_amount == Decimal("0.00")
        assert fresh.hold_expires_at == now + timedelta(minutes=10)
        assert len(fresh.qr_nonce) >= 16
        assert fresh.checked_in_at is fresh.checked_out_at is fresh.cancelled_at is None

    def test_hold_length_comes_from_settings(self, driver, vehicle, world, window, now):
        with override_settings(BOOKING_HOLD_MINUTES=3):
            booking = book(world, driver, vehicle, window, now)
        assert booking.hold_expires_at == now + timedelta(minutes=3)

    def test_records_a_creation_event(self, driver, vehicle, world, window, now):
        booking = book(world, driver, vehicle, window, now)
        (event,) = BookingEvent.objects.filter(booking=booking)
        assert (event.from_status, event.to_status) == ("", S.PENDING_PAYMENT)
        assert event.actor == driver
        assert event.reason == "created"

    def test_audit_line_is_emitted_after_commit(
        self, driver, vehicle, world, window, now, caplog, django_capture_on_commit_callbacks
    ):
        with caplog.at_level(logging.INFO, logger="habi.audit"):
            with django_capture_on_commit_callbacks(execute=True):
                booking = book(world, driver, vehicle, window, now)
        record = next(
            r for r in caplog.records if getattr(r, "audit_action", None) == "booking.create"
        )
        assert record.audit_object == str(booking.pk)
        assert record.audit_actor == str(driver.pk)

    def test_expire_hold_is_scheduled_after_commit(
        self, driver, vehicle, world, window, now, django_capture_on_commit_callbacks
    ):
        with mock.patch("apps.bookings.tasks.expire_hold.apply_async") as schedule:
            with django_capture_on_commit_callbacks(execute=True):
                booking = book(world, driver, vehicle, window, now)
        schedule.assert_called_once_with(
            (str(booking.pk),), countdown=int(timedelta(minutes=10).total_seconds()) + 2
        )

    def test_a_broker_outage_does_not_fail_the_booking(
        self, driver, vehicle, world, window, now, django_capture_on_commit_callbacks
    ):
        with mock.patch(
            "apps.bookings.tasks.expire_hold.apply_async", side_effect=OSError("broker down")
        ):
            with django_capture_on_commit_callbacks(execute=True):
                booking = book(world, driver, vehicle, window, now)
        assert Booking.objects.filter(pk=booking.pk).exists()  # the beat sweep expires it

    def test_the_slot_status_and_lot_counters_are_not_touched(
        self, driver, vehicle, world, window, now
    ):
        """Time-range model: a future booking does not flip Slot.status (ARCHITECTURE 10.3)."""
        booking = book(world, driver, vehicle, window, now)
        booking.slot.refresh_from_db()
        world.lot.refresh_from_db()
        assert booking.slot.status == SlotStatus.FREE
        assert (world.lot.total_slots, world.lot.free_slots) == (3, 3)

    def test_two_users_get_different_slots_for_the_same_window(
        self, driver, vehicle, world, window, now
    ):
        other = make_user("DRIVER")
        first = book(world, driver, vehicle, window, now)
        second = book(world, other, make_vehicle(other), window, now)
        assert first.slot != second.slot


class TestPeriodValidation:
    def create(self, world, driver, vehicle, now, start, end):
        return book(world, driver, vehicle, (start, end), now)

    @pytest.mark.parametrize(
        ("start_h", "end_h", "code"),
        [
            (1, 1, "period_invalid"),  # empty
            (2, 1, "period_invalid"),  # reversed
            (1, 1.49, "period_too_short"),  # 29 min
            (-1, 1, "start_in_past"),
            (24 * 31, 24 * 31 + 2, "too_far_ahead"),
            (1, 25.1, "period_too_long"),
        ],
    )
    def test_rejected_with_a_specific_422_code(
        self, world, driver, vehicle, now, start_h, end_h, code
    ):
        with pytest.raises(UnprocessableError) as info:
            self.create(
                world,
                driver,
                vehicle,
                now,
                now + timedelta(hours=start_h),
                now + timedelta(hours=end_h),
            )
        assert info.value.status_code == 422
        assert code_of(info) == code
        assert not Booking.objects.exists()

    @pytest.mark.parametrize("minutes", [30, 31, 24 * 60])
    def test_duration_boundaries_accepted(self, world, driver, vehicle, now, minutes):
        start = now + timedelta(hours=1)
        assert self.create(world, driver, vehicle, now, start, start + timedelta(minutes=minutes))

    def test_start_slightly_in_the_past_is_tolerated(self, world, driver, vehicle, now):
        start = now - timedelta(minutes=4)
        assert self.create(world, driver, vehicle, now, start, start + timedelta(hours=1))

    def test_start_beyond_the_tolerance_is_rejected(self, world, driver, vehicle, now):
        start = now - timedelta(minutes=6)
        with pytest.raises(UnprocessableError) as info:
            self.create(world, driver, vehicle, now, start, start + timedelta(hours=1))
        assert code_of(info) == "start_in_past"

    def test_seconds_are_dropped(self, world, driver, vehicle, now):
        start = now + timedelta(hours=1, seconds=45, microseconds=5)
        booking = self.create(world, driver, vehicle, now, start, start + timedelta(hours=1))
        assert booking.starts_at == now + timedelta(hours=1)
        assert booking.ends_at == now + timedelta(hours=2)

    def test_limits_come_from_settings(self, world, driver, vehicle, now):
        start = now + timedelta(hours=1)
        with override_settings(BOOKING_MIN_DURATION_MINUTES=60):
            with pytest.raises(UnprocessableError) as info:
                self.create(world, driver, vehicle, now, start, start + timedelta(minutes=45))
        assert code_of(info) == "period_too_short"


class TestWorkingHours:
    def test_booking_outside_opening_hours_is_rejected(self, driver, vehicle, now):
        world = make_world(open_time=time(8), close_time=time(20))
        # whatever the hour is now, build a window that starts at 21:00 Tashkent time tomorrow
        from apps.parking.ranking import LOCAL_TZ

        tomorrow = (now.astimezone(LOCAL_TZ) + timedelta(days=1)).replace(hour=21, minute=0)
        with pytest.raises(UnprocessableError) as info:
            book(world, driver, vehicle, (tomorrow, tomorrow + timedelta(hours=1)), now)
        assert code_of(info) == "lot_closed"

    def test_booking_inside_hours_is_accepted(self, driver, vehicle, now):
        world = make_world(open_time=time(8), close_time=time(20))
        from apps.parking.ranking import LOCAL_TZ

        start = (now.astimezone(LOCAL_TZ) + timedelta(days=1)).replace(hour=9, minute=0)
        assert book(world, driver, vehicle, (start, start + timedelta(hours=2)), now)

    def test_overnight_lot(self, driver, vehicle, now):
        world = make_world(open_time=time(22), close_time=time(6))
        from apps.parking.ranking import LOCAL_TZ

        start = (now.astimezone(LOCAL_TZ) + timedelta(days=1)).replace(hour=23, minute=0)
        assert book(world, driver, vehicle, (start, start + timedelta(hours=4)), now)
        noon = start.replace(hour=12)
        with pytest.raises(UnprocessableError):
            book(world, driver, vehicle, (noon, noon + timedelta(hours=1)), now)

    def test_a_later_hours_change_does_not_touch_existing_bookings(self, driver, vehicle, now):
        world = make_world(open_time=time(8), close_time=time(20))
        from apps.parking.ranking import LOCAL_TZ

        start = (now.astimezone(LOCAL_TZ) + timedelta(days=1)).replace(hour=9, minute=0)
        booking = book(world, driver, vehicle, (start, start + timedelta(hours=2)), now)
        ParkingLot.objects.filter(pk=world.lot.pk).update(open_time=time(12), close_time=time(14))
        booking.refresh_from_db()
        assert booking.status == S.PENDING_PAYMENT
        assert booking.ends_at == start + timedelta(hours=2)


class TestPreconditions:
    def test_vehicle_of_another_user_is_rejected(self, driver, world, window, now):
        stranger_vehicle = make_vehicle(make_user("DRIVER"))
        with pytest.raises(UnprocessableError) as info:
            book(world, driver, stranger_vehicle, window, now)
        assert code_of(info) == "vehicle_not_found"

    @pytest.mark.parametrize(
        ("vehicle_type", "slot_type", "ok"),
        [("CAR", "EV", False), ("CAR", "STANDARD", True), ("TRUCK", "STANDARD", False)],
    )
    def test_vehicle_type_must_fit_the_slot_type(
        self, driver, now, window, vehicle_type, slot_type, ok
    ):
        world = make_world(slots=1, slot_type=slot_type)
        vehicle = make_vehicle(driver, vehicle_type)
        if ok:
            assert book(world, driver, vehicle, window, now, slot_type=slot_type)
            return
        with pytest.raises(UnprocessableError) as info:
            book(world, driver, vehicle, window, now, slot_type=slot_type)
        assert code_of(info) == "vehicle_slot_mismatch"

    def test_ev_vehicle_may_take_an_ev_slot(self, driver, now, window):
        world = make_world(slots=1, slot_type=SlotType.EV)
        booking = book(world, driver, make_vehicle(driver, "EV"), window, now, slot_type="EV")
        assert booking.slot.type == SlotType.EV

    def test_missing_tariff_is_422(self, driver, vehicle, world, window, now):
        Tariff.objects.all().delete()
        with pytest.raises(UnprocessableError) as info:
            book(world, driver, vehicle, window, now)
        assert code_of(info) == "no_tariff"

    @pytest.mark.parametrize("status", [LotStatus.PENDING_REVIEW, LotStatus.SUSPENDED])
    def test_inactive_lot_is_not_found(self, driver, vehicle, world, window, now, status):
        ParkingLot.objects.filter(pk=world.lot.pk).update(status=status)
        with pytest.raises(NotFoundError):
            book(world, driver, vehicle, window, now)

    def test_unknown_lot_is_not_found(self, driver, vehicle, window, now, db):
        import uuid

        with pytest.raises(NotFoundError):
            services.create_booking(
                user=driver,
                lot_id=uuid.uuid4(),
                slot_type="STANDARD",
                vehicle=vehicle,
                start=window[0],
                end=window[1],
                now=now,
            )


class TestAvailability:
    def test_no_slots_of_the_type_is_409(self, driver, now, window):
        world = make_world(slots=0)
        with pytest.raises(NoSlotAvailable) as info:
            book(world, driver, make_vehicle(driver), window, now)
        assert info.value.status_code == 409
        assert code_of(info) == "no_slot_available"

    def test_every_slot_booked_means_409_for_the_next_driver(
        self, driver, vehicle, world, window, now
    ):
        for _ in world.slots:
            other = make_user("DRIVER")
            book(world, other, make_vehicle(other), window, now)
        with pytest.raises(NoSlotAvailable):
            book(world, driver, vehicle, window, now)

    def test_out_of_service_slots_are_never_chosen(self, driver, vehicle, window, now):
        world = make_world(slots=2)
        Slot.objects.filter(pk=world.slots[0].pk).update(status=SlotStatus.OUT_OF_SERVICE)
        assert book(world, driver, vehicle, window, now).slot == world.slots[1]
        other = make_user("DRIVER")
        with pytest.raises(NoSlotAvailable):
            book(world, other, make_vehicle(other), window, now)

    def test_a_slot_is_reusable_right_after_the_previous_booking_ends(self, driver, vehicle, now):
        world = make_world(slots=1)
        first = (now + timedelta(hours=1), now + timedelta(hours=2))
        book(world, driver, vehicle, first, now)
        other = make_user("DRIVER")
        adjacent = (first[1], first[1] + timedelta(hours=1))  # half-open: [end, ...)
        assert book(world, other, make_vehicle(other), adjacent, now)

    @pytest.mark.parametrize("shift_min", [-60, -1, 0, 30, 59])
    def test_any_real_overlap_blocks(self, driver, vehicle, now, shift_min):
        world = make_world(slots=1)
        first = (now + timedelta(hours=2), now + timedelta(hours=4))
        book(world, driver, vehicle, first, now)
        other = make_user("DRIVER")
        clash = (first[0] + timedelta(minutes=shift_min), first[1] + timedelta(minutes=shift_min))
        with pytest.raises(NoSlotAvailable):
            book(world, other, make_vehicle(other), clash, now)

    @pytest.mark.parametrize("status", [S.CANCELLED, S.EXPIRED, S.COMPLETED, S.NO_SHOW])
    def test_finished_bookings_do_not_block(self, driver, vehicle, now, window, status):
        world = make_world(slots=1)
        other = make_user("DRIVER")
        make_booking(
            user=other,
            slot=world.slots[0],
            vehicle=make_vehicle(other),
            start=window[0],
            end=window[1],
            status=status,
        )
        assert book(world, driver, vehicle, window, now)

    @pytest.mark.parametrize("status", [S.PENDING_PAYMENT, S.CONFIRMED, S.ACTIVE, S.OVERSTAY])
    def test_live_bookings_block(self, driver, vehicle, now, window, status):
        world = make_world(slots=1)
        other = make_user("DRIVER")
        make_booking(
            user=other,
            slot=world.slots[0],
            vehicle=make_vehicle(other),
            start=window[0],
            end=window[1],
            status=status,
        )
        with pytest.raises(NoSlotAvailable):
            book(world, driver, vehicle, window, now)

    def test_bookings_in_another_lot_do_not_block(self, driver, vehicle, window, now):
        first, second = make_world(slots=1), make_world(slots=1)
        other = make_user("DRIVER")
        book(first, other, make_vehicle(other), window, now)
        assert book(second, driver, vehicle, window, now)

    def test_a_walk_in_on_a_slot_blocks_an_immediate_booking_only(self, driver, vehicle, now):
        world = make_world(slots=1)
        Slot.objects.filter(pk=world.slots[0].pk).update(status=SlotStatus.OCCUPIED)
        soon = (now + timedelta(minutes=5), now + timedelta(hours=1, minutes=5))
        with pytest.raises(NoSlotAvailable):
            book(world, driver, vehicle, soon, now)
        later = (now + timedelta(hours=3), now + timedelta(hours=4))
        assert book(world, driver, vehicle, later, now)


class TestSlotChoice:
    def test_best_fit_prefers_the_slot_that_just_became_free(self, driver, vehicle, now):
        world = make_world(slots=3)  # distances 0, 1, 2
        far = world.slots[2]
        other = make_user("DRIVER")
        make_booking(
            user=other,
            slot=far,
            vehicle=make_vehicle(other),
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            status=S.CONFIRMED,
        )
        window = (now + timedelta(hours=2), now + timedelta(hours=3))
        assert book(world, driver, vehicle, window, now).slot == far

    def test_otherwise_the_slot_nearest_the_entrance(self, driver, vehicle, window, now):
        world = make_world(slots=3)
        assert book(world, driver, vehicle, window, now).slot == world.slots[0]

    def test_preferred_slot_is_honoured(self, driver, vehicle, world, window, now):
        assert (
            book(world, driver, vehicle, window, now, preferred_slot_id=world.slots[2].pk).slot
            == world.slots[2]
        )

    def test_a_busy_preferred_slot_is_409_not_a_silent_substitute(
        self, driver, vehicle, world, window, now
    ):
        other = make_user("DRIVER")
        book(world, other, make_vehicle(other), window, now, preferred_slot_id=world.slots[1].pk)
        with pytest.raises(NoSlotAvailable):
            book(world, driver, vehicle, window, now, preferred_slot_id=world.slots[1].pk)

    def test_a_preferred_slot_of_another_lot_or_type_is_409(
        self, driver, vehicle, world, window, now
    ):
        foreign = make_world(slots=1)
        with pytest.raises(NoSlotAvailable):
            book(world, driver, vehicle, window, now, preferred_slot_id=foreign.slots[0].pk)
        ev = make_slot(world.zone, SlotType.EV)
        with pytest.raises(NoSlotAvailable):
            book(world, driver, vehicle, window, now, preferred_slot_id=ev.pk)


class TestPricing:
    def test_dynamic_factor_applies_when_the_lot_is_nearly_full(self, driver, vehicle, now, window):
        world = make_world(slots=10)
        for _ in range(9):
            other = make_user("DRIVER")
            book(world, other, make_vehicle(other), window, now)
        booking = book(world, driver, vehicle, window, now)
        # 9/10 booked -> occupancy 0.9 -> k = 1 + 0.5 * 0.1 = 1.05 on 12000
        assert booking.amount == Decimal("12600.00")

    def test_no_surcharge_at_the_threshold(self, driver, vehicle, now, window):
        world = make_world(slots=10)
        for _ in range(8):
            other = make_user("DRIVER")
            book(world, other, make_vehicle(other), window, now)
        assert book(world, driver, vehicle, window, now).amount == Decimal("12000.00")

    def test_time_coefficients_from_the_tariff_rules(self, driver, vehicle, now):
        from apps.parking.ranking import LOCAL_TZ

        rules = {"coefficients": [{"from": "00:00", "to": "12:00", "coefficient": "1.5"}]}
        world = make_world(slots=1, rules=rules)
        start = (now.astimezone(LOCAL_TZ) + timedelta(days=1)).replace(hour=8, minute=0)
        booking = book(world, driver, vehicle, (start, start + timedelta(hours=1)), now)
        assert booking.amount == Decimal("9000.00")  # 6000 * 1.5

    def test_a_later_tariff_change_does_not_touch_an_existing_booking(
        self, driver, vehicle, world, window, now
    ):
        booking = book(world, driver, vehicle, window, now)
        Tariff.objects.filter(pk=world.tariff.pk).update(price_per_hour=Decimal("99999"))
        booking.refresh_from_db()
        assert booking.amount == Decimal("12000.00")


class TestConstraintRace:
    """The EXCLUDE constraint can still fire (another writer); the service retries the next slot."""

    def test_falls_through_to_the_next_slot(self, driver, vehicle, world, window, now):
        real_save = Booking.save
        calls = {"n": 0}

        def flaky(self, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise pg_integrity_error("booking_no_overlap")
            return real_save(self, *args, **kwargs)

        with mock.patch.object(Booking, "save", flaky):
            booking = book(world, driver, vehicle, window, now)
        assert booking.slot == world.slots[1]
        assert Booking.objects.count() == 1

    def test_gives_up_with_409_after_the_attempt_limit(self, driver, vehicle, window, now):
        world = make_world(slots=8)
        with override_settings(BOOKING_MAX_PICK_ATTEMPTS=3):
            with mock.patch.object(
                Booking, "save", side_effect=pg_integrity_error("booking_no_overlap")
            ) as save:
                with pytest.raises(NoSlotAvailable):
                    book(world, driver, vehicle, window, now)
        assert save.call_count == 3
        assert not Booking.objects.exists()


class TestLockOrder:
    def test_lot_is_locked_before_any_slot(self, driver, vehicle, world, window, now):
        order = []
        real_lot, real_slot = services._lock_lot, services._lock_slot

        def lot(lot_id):
            order.append("lot")
            return real_lot(lot_id)

        def slot(slot_id):
            order.append("slot")
            return real_slot(slot_id)

        with (
            mock.patch.object(services, "_lock_lot", lot),
            mock.patch.object(services, "_lock_slot", slot),
        ):
            book(world, driver, vehicle, window, now)
        assert order[0] == "lot"
        assert "slot" in order
        assert order.index("lot") < order.index("slot")
