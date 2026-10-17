"""Review follow-ups: hoarding limits, vehicle exclusivity, paid amounts, batch isolation,
lock timeouts, expired-hold cleanup, exclusion-error narrowing, extend switch."""

import logging
from datetime import timedelta
from decimal import Decimal
from unittest import mock

import pytest
from django.db import IntegrityError, OperationalError, transaction
from freezegun import freeze_time

from apps.bookings import services, sweeps
from apps.bookings.errors import NoSlotAvailable
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError, InvalidTransition, UnprocessableError
from apps.parking.models import ParkingLot
from tests.bookings.factories import (
    FakePgError,
    make_booking,
    make_vehicle,
    make_world,
    pg_integrity_error,
)
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


def code_of(info):
    return str(info.value.detail["code"])


def book(world, user, vehicle, window, now, **extra):
    return services.create_booking(
        user=user,
        lot_id=world.lot.pk,
        slot_type="STANDARD",
        vehicle=vehicle,
        start=window[0],
        end=window[1],
        now=now,
        **extra,
    )


def at(now, start_h, length_h=1):
    return now + timedelta(hours=start_h), now + timedelta(hours=start_h + length_h)


class TestHoardingLimits:
    def test_third_unpaid_hold_is_refused(self, driver, vehicle, now):
        world = make_world(slots=5)
        book(world, driver, vehicle, at(now, 1), now)
        book(world, driver, make_vehicle(driver), at(now, 3), now)
        with pytest.raises(UnprocessableError) as info:
            book(world, driver, make_vehicle(driver), at(now, 5), now)
        assert code_of(info) == "booking_limit_reached"

    def test_pending_limit_comes_from_settings(self, driver, vehicle, now, settings):
        settings.BOOKING_MAX_PENDING = 1
        world = make_world(slots=3)
        book(world, driver, vehicle, at(now, 1), now)
        with pytest.raises(UnprocessableError):
            book(world, driver, make_vehicle(driver), at(now, 3), now)

    def test_paid_bookings_do_not_count_as_pending(self, driver, vehicle, now):
        world = make_world(slots=6)
        for i in range(3):
            make_booking(
                user=driver,
                slot=world.slots[i],
                vehicle=make_vehicle(driver),
                start=now + timedelta(hours=1 + 2 * i),
                end=now + timedelta(hours=2 + 2 * i),
                status=S.CONFIRMED,
            )
        assert book(world, driver, vehicle, at(now, 10), now)

    def test_total_live_bookings_limit(self, driver, now, settings):
        settings.BOOKING_MAX_ACTIVE = 3
        world = make_world(slots=6)
        for i in range(3):
            make_booking(
                user=driver,
                slot=world.slots[i],
                vehicle=make_vehicle(driver),
                start=now + timedelta(hours=1 + 2 * i),
                end=now + timedelta(hours=2 + 2 * i),
                status=S.CONFIRMED,
            )
        with pytest.raises(UnprocessableError) as info:
            book(world, driver, make_vehicle(driver), at(now, 10), now)
        assert code_of(info) == "booking_limit_reached"

    def test_finished_bookings_do_not_count(self, driver, vehicle, now, settings):
        settings.BOOKING_MAX_ACTIVE = 1
        world = make_world(slots=2)
        make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=make_vehicle(driver),
            start=now - timedelta(hours=5),
            end=now - timedelta(hours=4),
            status=S.COMPLETED,
        )
        assert book(world, driver, vehicle, at(now, 1), now)

    def test_limits_are_per_user(self, driver, vehicle, now):
        world = make_world(slots=5)
        book(world, driver, vehicle, at(now, 1), now)
        other = make_user("DRIVER")
        assert book(world, other, make_vehicle(other), at(now, 3), now)

    def _abandon(self, user, vehicle, world, now, count, minutes_ago=1):
        for i in range(count):
            booking = make_booking(
                user=user,
                slot=world.slots[i % len(world.slots)],
                vehicle=vehicle,
                start=now + timedelta(days=2 + i),
                end=now + timedelta(days=2 + i, hours=1),
                status=S.CANCELLED,
            )
            with freeze_time(now - timedelta(minutes=minutes_ago)):  # created_at is auto_now_add
                BookingEvent.objects.create(
                    booking=booking,
                    actor=user,
                    from_status=S.PENDING_PAYMENT,
                    to_status=S.CANCELLED,
                    reason="user_cancelled",
                )

    def test_create_cancel_create_cycle_hits_a_cooldown(self, driver, vehicle, now):
        world = make_world(slots=3)
        self._abandon(driver, vehicle, world, now, 5)
        with pytest.raises(ApiError) as info:
            book(world, driver, vehicle, at(now, 1), now)
        assert info.value.status_code == 429
        assert code_of(info) == "booking_cooldown"

    def test_old_abandoned_holds_are_forgiven(self, driver, vehicle, now):
        world = make_world(slots=3)
        self._abandon(driver, vehicle, world, now, 5, minutes_ago=30)
        assert book(world, driver, vehicle, at(now, 1), now)

    def test_fewer_than_the_threshold_is_fine(self, driver, vehicle, now):
        world = make_world(slots=3)
        self._abandon(driver, vehicle, world, now, 4)
        assert book(world, driver, vehicle, at(now, 1), now)

    def test_a_lot_owner_cannot_book_their_own_lot(self, now):
        world = make_world(slots=2)
        vehicle = make_vehicle(world.owner)
        with pytest.raises(UnprocessableError) as info:
            book(world, world.owner, vehicle, at(now, 1), now)
        assert code_of(info) == "own_lot_booking"

    def test_another_owner_may_book_here(self, now):
        world = make_world(slots=2)
        other_owner = make_user("OWNER")
        assert book(world, other_owner, make_vehicle(other_owner), at(now, 1), now)


class TestVehicleExclusivity:
    def test_one_vehicle_cannot_hold_two_slots_at_once(self, driver, vehicle, now):
        world = make_world(slots=3)
        book(world, driver, vehicle, at(now, 1, 2), now)
        with pytest.raises(ApiError) as info:
            book(world, driver, vehicle, at(now, 2, 2), now)
        assert info.value.status_code == 409
        assert code_of(info) == "vehicle_busy"

    def test_back_to_back_is_fine(self, driver, vehicle, now):
        world = make_world(slots=3)
        book(world, driver, vehicle, at(now, 1), now)
        assert book(world, driver, vehicle, at(now, 2), now)

    def test_finished_bookings_do_not_block_the_vehicle(self, driver, vehicle, now):
        world = make_world(slots=3)
        make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            status=S.CANCELLED,
        )
        assert book(world, driver, vehicle, at(now, 1), now)

    def test_database_exclusion_on_the_vehicle_maps_to_vehicle_busy(self, driver, vehicle, now):
        world = make_world(slots=3)
        error = pg_integrity_error("booking_vehicle_no_overlap")
        with mock.patch.object(Booking, "save", side_effect=error):
            with pytest.raises(ApiError) as info:
                book(world, driver, vehicle, at(now, 1), now)
        assert code_of(info) == "vehicle_busy"

    def test_extension_cannot_run_into_the_same_vehicles_next_booking(
        self, driver, vehicle, now, settings
    ):
        settings.BOOKING_EXTEND_ENABLED = True
        world = make_world(slots=3)
        first = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            status=S.CONFIRMED,
        )
        make_booking(
            user=driver,
            slot=world.slots[1],
            vehicle=vehicle,
            start=now + timedelta(hours=2, minutes=30),
            end=now + timedelta(hours=4),
            status=S.CONFIRMED,
        )
        with pytest.raises(ApiError) as info:
            services.extend_booking(
                booking_id=first.pk,
                user=driver,
                new_end=first.ends_at + timedelta(hours=1),
                now=now,
            )
        assert code_of(info) == "vehicle_busy"


class TestExclusionErrorNarrowing:
    def test_only_exclusion_violations_are_swallowed(self, driver, vehicle, now):
        world = make_world(slots=3)
        with mock.patch.object(Booking, "save", side_effect=pg_integrity_error("some_fk", "23503")):
            with pytest.raises(IntegrityError):
                book(world, driver, vehicle, at(now, 1), now)

    def test_a_plain_integrity_error_without_a_cause_is_not_swallowed(self, driver, vehicle, now):
        world = make_world(slots=3)
        with mock.patch.object(Booking, "save", side_effect=IntegrityError("boom")):
            with pytest.raises(IntegrityError):
                book(world, driver, vehicle, at(now, 1), now)

    def test_slot_exclusion_moves_on_to_the_next_slot(self, driver, vehicle, now):
        world = make_world(slots=3)
        real_save, calls = Booking.save, {"n": 0}

        def flaky(self, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise pg_integrity_error("booking_no_overlap")
            return real_save(self, *args, **kwargs)

        with mock.patch.object(Booking, "save", flaky):
            assert book(world, driver, vehicle, at(now, 1), now).slot == world.slots[1]


class TestLockTimeout:
    def test_a_lock_wait_timeout_is_a_retryable_503(self, driver, vehicle, now):
        world = make_world(slots=2)
        error = OperationalError("canceling statement due to lock timeout")
        error.__cause__ = FakePgError("55P03")
        with mock.patch.object(services, "_lock_lot", side_effect=error):
            with pytest.raises(ApiError) as info:
                book(world, driver, vehicle, at(now, 1), now)
        assert info.value.status_code == 503
        assert code_of(info) == "lock_timeout"

    def test_other_operational_errors_propagate(self, driver, vehicle, now):
        world = make_world(slots=2)
        with mock.patch.object(services, "_lock_lot", side_effect=OperationalError("disk")):
            with pytest.raises(OperationalError):
                book(world, driver, vehicle, at(now, 1), now)


class TestExpiredHoldsDoNotBlock:
    def test_an_overdue_hold_is_expired_instead_of_causing_a_false_409(self, driver, now):
        world = make_world(slots=1)
        other = make_user("DRIVER")
        stale = make_booking(
            user=other,
            slot=world.slots[0],
            vehicle=make_vehicle(other),
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=3),
            hold_expires_at=now - timedelta(minutes=1),
        )
        booking = book(world, driver, make_vehicle(driver), at(now, 1, 2), now)
        assert booking.slot == world.slots[0]
        assert Booking.objects.get(pk=stale.pk).status == S.EXPIRED

    def test_a_live_hold_still_blocks(self, driver, now):
        world = make_world(slots=1)
        other = make_user("DRIVER")
        make_booking(
            user=other,
            slot=world.slots[0],
            vehicle=make_vehicle(other),
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=3),
            hold_expires_at=now + timedelta(minutes=5),
        )
        with pytest.raises(NoSlotAvailable):
            book(world, driver, make_vehicle(driver), at(now, 1, 2), now)


class TestPaidAmount:
    def test_refund_is_a_share_of_what_was_paid(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=3),
            end=now + timedelta(hours=4),
            status=S.CONFIRMED,
            amount="12000",
            paid_amount="8000",
        )
        cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.refund_amount == Decimal("8000.00")  # 100% of paid, not of amount

    def test_refund_never_exceeds_the_payment(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(minutes=30),
            end=now + timedelta(hours=2),
            status=S.CONFIRMED,
            amount="12000",
            paid_amount="0",
        )
        assert services.cancel_preview(booking, now=now).refund_amount == Decimal("0.00")

    def test_new_bookings_start_unpaid(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = book(world, driver, vehicle, at(now, 1), now)
        assert booking.paid_amount == Decimal("0.00")

    def test_confirm_records_the_payment_and_moves_to_confirmed(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = book(world, driver, vehicle, at(now, 1), now)
        confirmed = services.confirm_booking(booking.pk, paid_amount=booking.amount, now=now)
        assert confirmed.status == S.CONFIRMED
        assert confirmed.paid_amount == booking.amount
        event = BookingEvent.objects.filter(booking=booking).latest("created_at")
        assert (event.from_status, event.to_status, event.reason) == (
            S.PENDING_PAYMENT,
            S.CONFIRMED,
            "payment_confirmed",
        )

    @pytest.mark.parametrize("paid", ["-1", "12000.01"])
    def test_confirm_rejects_impossible_amounts(self, driver, vehicle, now, paid):
        world = make_world(slots=1)
        booking = book(world, driver, vehicle, at(now, 1), now)
        with pytest.raises(ValueError, match="paid_amount"):
            services.confirm_booking(booking.pk, paid_amount=Decimal(paid), now=now)

    def test_confirming_an_expired_booking_is_refused(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            status=S.EXPIRED,
        )
        with pytest.raises(InvalidTransition):
            services.confirm_booking(booking.pk, paid_amount=booking.amount, now=now)

    def test_paid_cannot_exceed_amount_in_the_database(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = book(world, driver, vehicle, at(now, 1), now)
        with pytest.raises(IntegrityError):
            Booking.objects.filter(pk=booking.pk).update(paid_amount=booking.amount + 1)


class TestExtendSwitch:
    def test_the_switch_defaults_to_off(self):
        from django.conf import settings

        assert settings.BOOKING_EXTEND_ENABLED is False

    def test_extension_is_off_by_default(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=1),
            end=now + timedelta(hours=2),
            status=S.CONFIRMED,
        )
        with pytest.raises(ApiError) as info:
            services.extend_booking(
                booking_id=booking.pk, user=driver, new_end=booking.ends_at + timedelta(hours=1)
            )
        assert info.value.status_code == 409
        assert code_of(info) == "extend_unavailable"
        assert Booking.objects.get(pk=booking.pk).ends_at == booking.ends_at


class TestBatchIsolation:
    def test_a_poison_booking_does_not_stop_the_sweep(self, driver, vehicle, now, caplog):
        world = make_world(slots=3)
        ids = [
            make_booking(
                user=driver,
                slot=world.slots[i],
                vehicle=make_vehicle(driver),
                start=now - timedelta(hours=1, minutes=i),
                end=now + timedelta(hours=1),
                status=S.CONFIRMED,
            ).pk
            for i in range(3)
        ]
        real = sweeps._system_transition
        calls = []

        def flaky(booking_id, **kwargs):
            calls.append(booking_id)
            if len(calls) == 1:
                raise RuntimeError("poison")
            return real(booking_id, **kwargs)

        with caplog.at_level(logging.ERROR, logger="apps.bookings.sweeps"):
            with mock.patch.object(sweeps, "_system_transition", flaky):
                assert services.mark_no_shows(now=now) == 2
        assert len(calls) == 3
        statuses = [Booking.objects.get(pk=i).status for i in ids]
        assert statuses.count(S.NO_SHOW) == 2
        assert any("poison" in r.getMessage() or r.exc_info for r in caplog.records)
        # no personal data in the log line: only the booking id
        assert not any("plate" in r.getMessage().lower() for r in caplog.records)

    def test_failures_are_counted(self, driver, vehicle, now):
        world = make_world(slots=1)
        make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now - timedelta(hours=2),
            end=now + timedelta(hours=1),
            status=S.CONFIRMED,
        )
        with mock.patch.object(sweeps, "_system_transition", side_effect=RuntimeError("x")):
            assert services.mark_no_shows(now=now) == 0


class TestCancelIsIdempotent:
    def test_cancelling_an_already_cancelled_booking_returns_it(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=3),
            end=now + timedelta(hours=4),
            status=S.CONFIRMED,
        )
        first = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        again = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert again.status == S.CANCELLED
        assert again.refund_amount == first.refund_amount
        assert (
            BookingEvent.objects.filter(
                booking=booking, to_status=S.CANCELLED, from_status=S.CONFIRMED
            ).count()
            == 1
        )

    def test_other_terminal_states_still_conflict(self, driver, vehicle, now):
        world = make_world(slots=1)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=now + timedelta(hours=3),
            end=now + timedelta(hours=4),
            status=S.EXPIRED,
        )
        with pytest.raises(InvalidTransition):
            services.cancel_booking(booking_id=booking.pk, user=driver, now=now)


class TestVehicleLookupRace:
    def test_a_vehicle_deleted_meanwhile_is_a_422(self, driver, vehicle, now):
        world = make_world(slots=1)
        ghost = make_vehicle(driver)
        ghost.delete()
        with pytest.raises(UnprocessableError) as info:
            book(world, driver, ghost, at(now, 1), now)
        assert code_of(info) == "vehicle_not_found"


class TestPoliciesAreReadFromParking:
    def test_half_open_hours_cannot_exist_in_the_database(self):
        from datetime import time

        owner = make_user("OWNER")
        from tests.helpers import make_lot

        with pytest.raises(IntegrityError), transaction.atomic():
            make_lot(owner, open_time=time(8), close_time=None)
        assert ParkingLot.objects.count() == 0
