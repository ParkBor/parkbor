"""cancel / extend / expire_hold / no-show / overstay (ARCHITECTURE 6.2, 10.7)."""

import logging
from datetime import time, timedelta
from decimal import Decimal
from unittest import mock

import pytest
from django.test import override_settings

from apps.bookings import services
from apps.bookings.errors import BookingConflict
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import InvalidTransition, NotFoundError, UnprocessableError
from apps.parking.models import ParkingLot, Slot, SlotStatus
from tests.bookings.factories import make_booking, make_vehicle, make_world, pg_integrity_error
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


def code_of(info):
    return str(info.value.detail["code"])


@pytest.fixture
def make(driver, vehicle, world, now):
    """Factory for this driver's bookings relative to `now`."""

    def build(status=S.CONFIRMED, start_min=120, length_min=120, amount="12000", **extra):
        start = now + timedelta(minutes=start_min)
        return make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=start,
            end=start + timedelta(minutes=length_min),
            status=status,
            amount=amount,
            **extra,
        )

    return build


class TestRefundPolicy:
    @pytest.mark.parametrize(
        ("minutes_before_start", "percent", "refund"),
        [
            (180, 100, "12000.00"),
            (61, 100, "12000.00"),
            (60, 100, "12000.00"),  # exactly one hour left still counts as "an hour or more"
            (59, 50, "6000.00"),
            (1, 50, "6000.00"),
            (0, 0, "0.00"),  # the start instant
            (-30, 0, "0.00"),  # already started
        ],
    )
    def test_percentages(self, make, driver, now, minutes_before_start, percent, refund):
        booking = make(start_min=minutes_before_start)
        cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.status == S.CANCELLED
        assert cancelled.refund_amount == Decimal(refund)
        assert services.refund_percent_for(booking.starts_at, now) == percent

    def test_refund_rounds_half_up_to_cents(self, make, driver, now):
        booking = make(start_min=30, amount="12345.67")
        cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.refund_amount == Decimal("6172.84")  # 6172.835 -> half up

    def test_policy_comes_from_settings(self, make, driver, now):
        booking = make(start_min=30)
        with override_settings(BOOKING_CANCEL_LATE_PERCENT=20):
            cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.refund_amount == Decimal("2400.00")

    def test_policy_window_comes_from_settings(self, make, driver, now):
        booking = make(start_min=100)
        with override_settings(BOOKING_CANCEL_FULL_REFUND_MINUTES=120):
            cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.refund_amount == Decimal("6000.00")

    def test_preview_matches_the_real_cancellation(self, make, driver, now):
        booking = make(start_min=30)
        preview = services.cancel_preview(booking, now=now)
        assert (preview.can_cancel, preview.refund_percent, preview.refund_amount) == (
            True,
            50,
            Decimal("6000.00"),
        )
        cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.refund_amount == preview.refund_amount

    @pytest.mark.parametrize(
        "status", [S.ACTIVE, S.OVERSTAY, S.COMPLETED, S.CANCELLED, S.EXPIRED, S.NO_SHOW]
    )
    def test_preview_of_a_non_cancellable_booking(self, make, now, status):
        preview = services.cancel_preview(make(status=status), now=now)
        assert (preview.can_cancel, preview.refund_amount, preview.refund_percent) == (
            False,
            Decimal("0.00"),
            0,
        )


class TestCancel:
    def test_confirmed_booking_is_cancelled_with_event_and_timestamp(
        self, make, driver, now, caplog
    ):
        booking = make()
        cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.status == S.CANCELLED
        assert cancelled.cancelled_at == now
        event = BookingEvent.objects.get(booking=booking, reason="user_cancelled")
        assert (event.from_status, event.to_status) == (S.CONFIRMED, S.CANCELLED)
        assert event.actor == driver
        assert event.reason == "user_cancelled"
        assert event.meta["refund_amount"] == "12000.00"

    def test_pending_booking_can_be_abandoned_without_a_refund(self, make, driver, now):
        booking = make(status=S.PENDING_PAYMENT, hold_expires_at=now + timedelta(minutes=5))
        cancelled = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert cancelled.status == S.CANCELLED
        assert cancelled.refund_amount == Decimal("0.00")

    def test_the_slot_is_free_again(self, make, driver, other_driver, world, now):
        booking = make()
        services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        again = services.create_booking(
            user=other_driver,
            lot_id=world.lot.pk,
            slot_type="STANDARD",
            vehicle=make_vehicle(other_driver),
            start=booking.starts_at,
            end=booking.ends_at,
            preferred_slot_id=booking.slot_id,
            now=now,
        )
        assert again.slot_id == booking.slot_id

    @pytest.mark.parametrize("status", [S.ACTIVE, S.OVERSTAY, S.COMPLETED, S.EXPIRED, S.NO_SHOW])
    def test_other_states_are_409_invalid_transition(self, make, driver, now, status):
        booking = make(status=status)
        with pytest.raises(InvalidTransition) as info:
            services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert info.value.status_code == 409
        assert Booking.objects.get(pk=booking.pk).status == status

    def test_cancelling_twice_returns_the_cancelled_booking(self, make, driver, now):
        booking = make()
        services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        again = services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert again.status == S.CANCELLED

    def test_someone_elses_booking_is_not_found(self, make, other_driver, now):
        booking = make()
        with pytest.raises(NotFoundError):
            services.cancel_booking(booking_id=booking.pk, user=other_driver, now=now)
        assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED

    def test_lot_is_locked_before_the_booking(self, make, driver, now):
        booking = make()
        order = []
        real_lot = services._lock_lot
        real_booking = services._lock_booking_row

        def lot(lot_id):
            order.append("lot")
            return real_lot(lot_id)

        def row(booking_id):
            order.append("booking")
            return real_booking(booking_id)

        with (
            mock.patch.object(services, "_lock_lot", lot),
            mock.patch.object(services, "_lock_booking_row", row),
        ):
            services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        assert order == ["lot", "booking"]

    def test_audit_line(self, make, driver, now, caplog, django_capture_on_commit_callbacks):
        booking = make()
        with caplog.at_level(logging.INFO, logger="habi.audit"):
            with django_capture_on_commit_callbacks(execute=True):
                services.cancel_booking(booking_id=booking.pk, user=driver, now=now)
        record = next(
            r for r in caplog.records if getattr(r, "audit_action", "") == "booking.cancel"
        )
        assert record.audit_before["status"] == S.CONFIRMED
        assert record.audit_after["status"] == S.CANCELLED


class TestExtend:
    @pytest.fixture(autouse=True)
    def _extension_enabled(self, settings):
        settings.BOOKING_EXTEND_ENABLED = True  # off by default until payments (Step 8)

    def new_end(self, booking, minutes):
        return booking.ends_at + timedelta(minutes=minutes)

    def test_extends_period_and_adds_the_price_of_the_extra_time(self, make, driver, now):
        booking = make()
        result = services.extend_booking(
            booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 60), now=now
        )
        assert result.booking.ends_at == booking.ends_at + timedelta(hours=1)
        assert result.booking.starts_at == booking.starts_at
        assert result.extra_amount == Decimal("6000.00")  # no free minutes for an extension
        assert result.booking.amount == Decimal("18000.00")
        assert result.booking.status == S.CONFIRMED

    def test_extension_is_rounded_up_to_blocks(self, make, driver, now):
        booking = make()
        result = services.extend_booking(
            booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 20), now=now
        )
        assert result.extra_amount == Decimal("3000.00")  # 20 min -> two 15-min blocks

    def test_active_bookings_can_be_extended(self, make, driver, now):
        booking = make(status=S.ACTIVE, start_min=-30, length_min=90)
        result = services.extend_booking(
            booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 30), now=now
        )
        assert result.booking.status == S.ACTIVE
        assert result.booking.ends_at == booking.ends_at + timedelta(minutes=30)

    def test_the_period_event_is_recorded_without_a_status_change(self, make, driver, now):
        booking = make()
        services.extend_booking(
            booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 60), now=now
        )
        event = BookingEvent.objects.filter(booking=booking).latest("created_at")
        assert (event.from_status, event.to_status, event.reason) == (
            S.CONFIRMED,
            S.CONFIRMED,
            "extended",
        )
        assert event.meta["extra_amount"] == "6000.00"

    def test_a_following_booking_blocks_the_extension(self, make, driver, world, now):
        booking = make()
        other = make_user("DRIVER")
        make_booking(
            user=other,
            slot=booking.slot,
            vehicle=make_vehicle(other),
            start=booking.ends_at + timedelta(minutes=30),
            end=booking.ends_at + timedelta(hours=2),
            status=S.CONFIRMED,
        )
        with pytest.raises(BookingConflict) as info:
            services.extend_booking(
                booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 60), now=now
            )
        assert info.value.status_code == 409
        assert code_of(info) == "booking_conflict"
        fresh = Booking.objects.get(pk=booking.pk)
        assert (fresh.ends_at, fresh.amount) == (booking.ends_at, Decimal("12000.00"))

    def test_extension_up_to_the_next_booking_is_allowed(self, make, driver, now):
        booking = make()
        other = make_user("DRIVER")
        make_booking(
            user=other,
            slot=booking.slot,
            vehicle=make_vehicle(other),
            start=booking.ends_at + timedelta(minutes=30),
            end=booking.ends_at + timedelta(hours=2),
            status=S.CONFIRMED,
        )
        result = services.extend_booking(
            booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 30), now=now
        )
        assert result.booking.ends_at == other.bookings.get().starts_at

    def test_database_level_overlap_is_reported_as_booking_conflict(self, make, driver, now):
        booking = make()
        with mock.patch.object(
            Booking, "save", side_effect=pg_integrity_error("booking_no_overlap")
        ):
            with pytest.raises(BookingConflict):
                services.extend_booking(
                    booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 60), now=now
                )

    def test_total_duration_is_capped(self, make, driver, now):
        booking = make(length_min=23 * 60)
        with pytest.raises(UnprocessableError) as info:
            services.extend_booking(
                booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 90), now=now
            )
        assert code_of(info) == "period_too_long"

    @pytest.mark.parametrize("minutes", [0, -15])
    def test_must_extend_forward(self, make, driver, now, minutes):
        booking = make()
        with pytest.raises(UnprocessableError) as info:
            services.extend_booking(
                booking_id=booking.pk, user=driver, new_end=self.new_end(booking, minutes), now=now
            )
        assert code_of(info) == "period_invalid"

    def test_cannot_run_past_closing_time(self, driver, vehicle, now):
        from apps.parking.ranking import LOCAL_TZ

        world = make_world(slots=1, open_time=time(8), close_time=time(20))
        start = (now.astimezone(LOCAL_TZ) + timedelta(days=1)).replace(hour=18, minute=0)
        booking = make_booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            start=start,
            end=start + timedelta(hours=1),
            status=S.CONFIRMED,
        )
        with pytest.raises(UnprocessableError) as info:
            services.extend_booking(
                booking_id=booking.pk,
                user=driver,
                new_end=booking.ends_at + timedelta(hours=2),
                now=now,
            )
        assert code_of(info) == "lot_closed"
        ok = services.extend_booking(
            booking_id=booking.pk,
            user=driver,
            new_end=booking.ends_at + timedelta(hours=1),
            now=now,
        )
        assert ok.booking.ends_at == start.replace(hour=20)

    @pytest.mark.parametrize(
        "status", [S.PENDING_PAYMENT, S.OVERSTAY, S.COMPLETED, S.CANCELLED, S.EXPIRED, S.NO_SHOW]
    )
    def test_other_states_cannot_be_extended(self, make, driver, now, status):
        booking = make(status=status)
        with pytest.raises(InvalidTransition):
            services.extend_booking(
                booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 30), now=now
            )

    def test_an_ended_period_cannot_be_extended(self, make, driver, now):
        booking = make(status=S.ACTIVE, start_min=-180, length_min=120)
        with pytest.raises(InvalidTransition):
            services.extend_booking(
                booking_id=booking.pk, user=driver, new_end=now + timedelta(hours=1), now=now
            )

    def test_someone_elses_booking_is_not_found(self, make, other_driver, now):
        booking = make()
        with pytest.raises(NotFoundError):
            services.extend_booking(
                booking_id=booking.pk, user=other_driver, new_end=self.new_end(booking, 30), now=now
            )

    def test_extension_uses_todays_tariff_but_leaves_the_old_amount_alone(
        self, make, driver, world, now
    ):
        booking = make()
        world.tariff.price_per_hour = Decimal("10000")
        world.tariff.save()
        result = services.extend_booking(
            booking_id=booking.pk, user=driver, new_end=self.new_end(booking, 60), now=now
        )
        assert result.extra_amount == Decimal("10000.00")
        assert result.booking.amount == Decimal("22000.00")  # 12000 frozen + 10000


class TestExpireHold:
    def pending(self, make, now, hold_min=-1, **extra):
        return make(
            status=S.PENDING_PAYMENT, hold_expires_at=now + timedelta(minutes=hold_min), **extra
        )

    def test_expires_an_unpaid_booking(self, make, now):
        booking = self.pending(make, now)
        assert services.expire_hold(booking.pk, now=now) is True
        fresh = Booking.objects.get(pk=booking.pk)
        assert fresh.status == S.EXPIRED
        event = BookingEvent.objects.filter(booking=booking).latest("created_at")
        assert (event.from_status, event.to_status, event.reason) == (
            S.PENDING_PAYMENT,
            S.EXPIRED,
            "hold_expired",
        )
        assert event.actor is None

    def test_is_idempotent(self, make, now):
        booking = self.pending(make, now)
        assert services.expire_hold(booking.pk, now=now) is True
        assert services.expire_hold(booking.pk, now=now) is False
        assert BookingEvent.objects.filter(booking=booking, to_status=S.EXPIRED).count() == 1

    def test_does_not_touch_a_booking_still_inside_its_hold(self, make, now):
        booking = self.pending(make, now, hold_min=5)
        assert services.expire_hold(booking.pk, now=now) is False
        assert Booking.objects.get(pk=booking.pk).status == S.PENDING_PAYMENT

    @pytest.mark.parametrize("status", [S.CONFIRMED, S.ACTIVE, S.CANCELLED, S.COMPLETED, S.NO_SHOW])
    def test_never_touches_other_states(self, make, now, status):
        booking = make(status=status)
        assert services.expire_hold(booking.pk, now=now) is False
        assert Booking.objects.get(pk=booking.pk).status == status

    def test_a_paid_booking_survives_a_late_task(self, make, now):
        booking = self.pending(make, now)
        Booking.objects.filter(pk=booking.pk)
        from apps.bookings.state import status_write_allowed

        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=S.CONFIRMED)
        assert services.expire_hold(booking.pk, now=now) is False
        assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED

    def test_unknown_id_is_a_quiet_no_op(self, now, db):
        import uuid

        assert services.expire_hold(uuid.uuid4(), now=now) is False

    def test_the_slot_is_released(self, make, driver, other_driver, world, now):
        booking = self.pending(make, now)
        services.expire_hold(booking.pk, now=now)
        assert services.create_booking(
            user=other_driver,
            lot_id=world.lot.pk,
            slot_type="STANDARD",
            vehicle=make_vehicle(other_driver),
            start=booking.starts_at,
            end=booking.ends_at,
            preferred_slot_id=booking.slot_id,
            now=now,
        )

    def test_sweep_expires_every_overdue_hold_in_batches(self, make, driver, vehicle, world, now):
        overdue = [
            make_booking(
                user=driver,
                slot=world.slots[i],
                vehicle=vehicle,
                start=now + timedelta(hours=1),
                end=now + timedelta(hours=2),
                hold_expires_at=now - timedelta(minutes=1),
            )
            for i in range(3)
        ]
        assert services.expire_overdue_holds(now=now, limit=2) == 2
        assert services.expire_overdue_holds(now=now, limit=2) == 1
        assert services.expire_overdue_holds(now=now, limit=2) == 0
        assert {b.status for b in Booking.objects.filter(pk__in=[o.pk for o in overdue])} == {
            S.EXPIRED
        }


class TestNoShowAndOverstay:
    def test_no_show_after_twenty_minutes(self, make, now):
        late = make(start_min=-21)
        on_time = make(start_min=-19)
        assert services.mark_no_shows(now=now) == 1
        assert Booking.objects.get(pk=late.pk).status == S.NO_SHOW
        assert Booking.objects.get(pk=on_time.pk).status == S.CONFIRMED

    def test_the_boundary_is_strict(self, make, now):
        booking = make(start_min=-20)
        assert services.mark_no_shows(now=now) == 0
        assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED

    def test_grace_comes_from_settings(self, make, now):
        booking = make(start_min=-11)
        with override_settings(BOOKING_NO_SHOW_GRACE_MINUTES=10):
            assert services.mark_no_shows(now=now) == 1
        assert Booking.objects.get(pk=booking.pk).status == S.NO_SHOW

    def test_only_confirmed_bookings_are_considered(self, make, now):
        make(status=S.PENDING_PAYMENT, start_min=-60, hold_expires_at=now + timedelta(minutes=5))
        make(status=S.ACTIVE, start_min=-60)
        assert services.mark_no_shows(now=now) == 0

    def test_is_idempotent_and_writes_one_event(self, make, now):
        booking = make(start_min=-60)
        assert services.mark_no_shows(now=now) == 1
        assert services.mark_no_shows(now=now) == 0
        events = BookingEvent.objects.filter(booking=booking, to_status=S.NO_SHOW)
        assert events.count() == 1
        assert events.get().actor is None
        assert events.get().reason == "no_show"

    def test_batch_limit(self, driver, vehicle, world, now):
        for slot in world.slots:
            make_booking(
                user=driver,
                slot=slot,
                vehicle=vehicle,
                start=now - timedelta(hours=1),
                end=now + timedelta(hours=1),
                status=S.CONFIRMED,
            )
        assert services.mark_no_shows(now=now, limit=2) == 2
        assert services.mark_no_shows(now=now, limit=2) == 1

    def test_overstay_when_the_period_has_ended(self, make, now):
        over = make(status=S.ACTIVE, start_min=-180, length_min=120)
        fine = make(status=S.ACTIVE, start_min=-60, length_min=120)
        assert services.detect_overstays(now=now) == 1
        assert Booking.objects.get(pk=over.pk).status == S.OVERSTAY
        assert Booking.objects.get(pk=fine.pk).status == S.ACTIVE

    def test_overstay_boundary_is_strict_and_idempotent(self, make, now):
        edge = make(status=S.ACTIVE, start_min=-120, length_min=120)
        assert services.detect_overstays(now=now) == 0
        assert services.detect_overstays(now=now + timedelta(minutes=1)) == 1
        assert services.detect_overstays(now=now + timedelta(minutes=1)) == 0
        events = BookingEvent.objects.filter(booking=edge, to_status=S.OVERSTAY)
        assert events.count() == 1
        assert events.get().reason == "overstay"

    def test_other_states_are_ignored_by_the_overstay_job(self, make, now):
        make(status=S.CONFIRMED, start_min=-180, length_min=120)
        make(status=S.COMPLETED, start_min=-180, length_min=120)
        assert services.detect_overstays(now=now) == 0

    def test_a_booking_changed_meanwhile_is_skipped(self, make, now):
        """The row is re-read under lock: a booking cancelled after selection stays cancelled."""
        booking = make(start_min=-60)
        real = services._lock_booking_row

        def cancelled_first(booking_id):
            from apps.bookings.state import status_write_allowed

            with status_write_allowed():
                Booking.objects.filter(pk=booking_id).update(status=S.CANCELLED)
            return real(booking_id)

        with mock.patch.object(services, "_lock_booking_row", cancelled_first):
            assert services.mark_no_shows(now=now) == 0
        assert Booking.objects.get(pk=booking.pk).status == S.CANCELLED


class TestSlotStatusSync:
    def test_sets_status_and_recounts_free_slots_under_the_lot_lock(self, world):
        order = []
        real_lot, real_slot = services._lock_lot, services._lock_slot_wait
        with (
            mock.patch.object(
                services, "_lock_lot", lambda i: (order.append("lot"), real_lot(i))[1]
            ),
            mock.patch.object(
                services, "_lock_slot_wait", lambda i: (order.append("slot"), real_slot(i))[1]
            ),
        ):
            services.sync_slot_status(world.slots[0].pk, SlotStatus.OCCUPIED)
        assert order == ["lot", "slot"]
        world.lot.refresh_from_db()
        assert (world.lot.total_slots, world.lot.free_slots) == (3, 2)
        services.sync_slot_status(world.slots[0].pk, SlotStatus.FREE)
        world.lot.refresh_from_db()
        assert world.lot.free_slots == 3

    def test_unknown_slot_is_not_found(self, db):
        import uuid

        with pytest.raises(NotFoundError):
            services.sync_slot_status(uuid.uuid4(), SlotStatus.FREE)

    def test_matches_the_parking_reconcile_definition(self, world):
        services.sync_slot_status(world.slots[1].pk, SlotStatus.RESERVED)
        lot = ParkingLot.objects.get(pk=world.lot.pk)
        real_free = Slot.objects.filter(zone__parking_lot=lot, status=SlotStatus.FREE).count()
        assert lot.free_slots == real_free
