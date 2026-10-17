"""Booking / BookingEvent model rules that hold on every database."""

import importlib
from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction

from apps.bookings.fields import make_period
from apps.bookings.models import (
    Booking,
    BookingEvent,
    ImmutableRecord,
    StatusWriteForbidden,
)
from apps.bookings.state import BookingStatus, status_write_allowed
from apps.core.exceptions import Conflict
from apps.parking import services as parking_services
from tests.bookings.factories import make_booking

pytestmark = pytest.mark.django_db


@pytest.fixture
def booking(driver, vehicle, world, window):
    return make_booking(
        user=driver, slot=world.slots[0], vehicle=vehicle, start=window[0], end=window[1]
    )


class TestPeriod:
    def test_period_round_trips_and_scalar_bounds_follow_it(self, booking, window):
        fresh = Booking.objects.get(pk=booking.pk)
        assert (fresh.period.lower, fresh.period.upper) == window
        assert (fresh.starts_at, fresh.ends_at) == window
        assert fresh.period.bounds == "[)"

    def test_changing_period_updates_the_scalar_columns(self, booking, window):
        booking.period = make_period(window[0], window[1] + timedelta(hours=1))
        booking.save(update_fields=["period"])
        fresh = Booking.objects.get(pk=booking.pk)
        assert fresh.ends_at == window[1] + timedelta(hours=1)

    def test_end_must_be_after_start(self, driver, vehicle, world, window):
        with pytest.raises(IntegrityError), transaction.atomic():
            make_booking(
                user=driver, slot=world.slots[0], vehicle=vehicle, start=window[1], end=window[0]
            )


class TestMoneyChecks:
    def test_negative_amount_rejected(self, driver, vehicle, world, window):
        with pytest.raises(IntegrityError), transaction.atomic():
            make_booking(
                user=driver,
                slot=world.slots[0],
                vehicle=vehicle,
                start=window[0],
                end=window[1],
                amount="-1",
            )

    def test_refund_cannot_exceed_amount(self, booking):
        with pytest.raises(IntegrityError), transaction.atomic():
            Booking.objects.filter(pk=booking.pk).update(refund_amount=Decimal("12000.01"))

    def test_refund_up_to_paid_amount_is_fine(self, booking):
        Booking.objects.filter(pk=booking.pk).update(
            paid_amount=booking.amount, refund_amount=booking.amount
        )

    def test_refund_cannot_exceed_what_was_paid(self, booking):
        """Step 8: a refund is a share of the money actually collected."""
        with pytest.raises(IntegrityError), transaction.atomic():
            Booking.objects.filter(pk=booking.pk).update(
                paid_amount=Decimal("5000"), refund_amount=Decimal("5000.01")
            )


class TestStatusGuard:
    def test_new_booking_must_start_pending(self, driver, vehicle, world, window):
        with pytest.raises(StatusWriteForbidden):
            Booking.objects.create(
                user=driver,
                slot=world.slots[0],
                vehicle=vehicle,
                period=make_period(*window),
                amount=Decimal("1"),
                status=BookingStatus.CONFIRMED,
            )

    def test_assigning_status_and_saving_is_refused(self, booking):
        booking.status = BookingStatus.CONFIRMED
        with pytest.raises(StatusWriteForbidden):
            booking.save()
        assert Booking.objects.get(pk=booking.pk).status == BookingStatus.PENDING_PAYMENT

    def test_update_fields_status_is_refused(self, booking):
        booking.status = BookingStatus.CONFIRMED
        with pytest.raises(StatusWriteForbidden):
            booking.save(update_fields=["status"])

    def test_queryset_update_status_is_refused(self, booking):
        with pytest.raises(StatusWriteForbidden):
            Booking.objects.filter(pk=booking.pk).update(status=BookingStatus.CONFIRMED)

    def test_bulk_update_status_is_refused(self, booking):
        booking.status = BookingStatus.CONFIRMED
        with pytest.raises(StatusWriteForbidden):
            Booking.objects.bulk_update([booking], ["status"])

    def test_other_fields_save_fine(self, booking):
        booking.amount = Decimal("500")
        booking.save(update_fields=["amount"])
        assert Booking.objects.get(pk=booking.pk).amount == Decimal("500.00")

    def test_sanctioned_write_works_and_resets_the_baseline(self, booking):
        with status_write_allowed():
            booking.status = BookingStatus.CONFIRMED
            booking.save(update_fields=["status"])
        booking.amount = Decimal("1")
        booking.save()  # status equals the persisted one again -> no guard
        assert Booking.objects.get(pk=booking.pk).status == BookingStatus.CONFIRMED

    def test_refresh_from_db_resets_the_baseline(self, booking):
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=BookingStatus.CONFIRMED)
        booking.refresh_from_db()
        booking.amount = Decimal("2")
        booking.save()  # must not trip the guard

    def test_bookings_cannot_be_deleted(self, booking):
        with pytest.raises(ImmutableRecord):
            booking.delete()
        with pytest.raises(ImmutableRecord):
            Booking.objects.filter(pk=booking.pk).delete()


class TestEventsAreAppendOnly:
    @pytest.fixture
    def event(self, booking, driver):
        return BookingEvent.objects.create(
            booking=booking, actor=driver, to_status="PENDING_PAYMENT", reason="created"
        )

    def test_cannot_be_modified(self, event):
        event.reason = "tampered"
        with pytest.raises(ImmutableRecord):
            event.save()
        with pytest.raises(ImmutableRecord):
            BookingEvent.objects.filter(pk=event.pk).update(reason="tampered")

    def test_cannot_be_deleted(self, event):
        with pytest.raises(ImmutableRecord):
            event.delete()
        with pytest.raises(ImmutableRecord):
            BookingEvent.objects.filter(pk=event.pk).delete()


class TestProtect:
    def test_slot_with_bookings_cannot_be_deleted_and_answers_409(self, booking, world):
        with pytest.raises(Conflict):
            parking_services.delete_slot(slot=world.slots[0])

    def test_zone_and_lot_deletion_are_conflicts_too(self, booking, world):
        with pytest.raises(Conflict):
            parking_services.delete_zone(zone=world.zone)

    def test_vehicle_with_bookings_is_protected(self, booking, vehicle):
        from django.db.models import ProtectedError

        with pytest.raises(ProtectedError), transaction.atomic():
            vehicle.delete()


class TestMigration:
    def test_btree_gist_comes_before_the_exclusion_constraint(self):
        from django.contrib.postgres.operations import BtreeGistExtension
        from django.db.migrations import AddConstraint

        module = importlib.import_module("apps.bookings.migrations.0001_initial")
        ops = module.Migration.operations
        gist = next(i for i, op in enumerate(ops) if isinstance(op, BtreeGistExtension))
        exclude = next(
            i
            for i, op in enumerate(ops)
            if isinstance(op, AddConstraint) and op.constraint.name == "booking_no_overlap"
        )
        assert gist == 0
        assert gist < exclude

    def test_exclusion_constraint_definition(self):
        constraint = next(c for c in Booking._meta.constraints if c.name == "booking_no_overlap")
        assert [(str(expr), op) for expr, op in constraint.expressions] == [
            ("slot", "="),
            ("period", "&&"),
        ]
        assert constraint.index_type.upper() == "GIST"
        lookup, statuses = constraint.condition.children[0]
        assert lookup == "status__in"
        assert set(statuses) == {"PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "OVERSTAY"}

    def test_constraint_ddl_is_skipped_on_sqlite(self):
        from types import SimpleNamespace

        editor = SimpleNamespace(connection=SimpleNamespace(vendor="sqlite"))
        for name in ("booking_no_overlap", "booking_period_valid"):
            constraint = next(c for c in Booking._meta.constraints if c.name == name)
            assert constraint.constraint_sql(Booking, editor) is None
            assert constraint.create_sql(Booking, editor) is None
            assert constraint.remove_sql(Booking, editor) is None


class TestPostgresDdlCompilesOffline:
    """No server here: render the PostgreSQL DDL with a detached backend to catch SQL mistakes."""

    @pytest.fixture
    def editor(self):
        from unittest import mock

        from django.db.backends.postgresql.base import DatabaseWrapper

        conn = DatabaseWrapper(
            {
                "ENGINE": "django.db.backends.postgresql",
                "NAME": "x",
                "USER": "u",
                "PASSWORD": "p",
                "HOST": "h",
                "PORT": "5432",
                "OPTIONS": {},
                "TIME_ZONE": None,
                "CONN_MAX_AGE": 0,
                "CONN_HEALTH_CHECKS": False,
                "AUTOCOMMIT": True,
                "ATOMIC_REQUESTS": False,
                "TEST": {},
            },
            "offline_pg",
        )
        with mock.patch.object(
            type(conn), "pg_version", new_callable=mock.PropertyMock, return_value=160000
        ):
            yield conn.schema_editor(collect_sql=True)

    def ddl(self, editor, name):
        constraint = next(c for c in Booking._meta.constraints if c.name == name)
        return str(constraint.create_sql(Booking, editor))

    def test_exclude_statement(self, editor):
        sql = self.ddl(editor, "booking_no_overlap")
        assert 'EXCLUDE USING GIST ("slot_id" WITH =, "period" WITH &&)' in sql
        assert "PENDING_PAYMENT" in sql and "OVERSTAY" in sql
        assert "COMPLETED" not in sql and "CANCELLED" not in sql

    def test_vehicle_exclude_statement(self, editor):
        sql = self.ddl(editor, "booking_vehicle_no_overlap")
        assert 'EXCLUDE USING GIST ("vehicle_plate" WITH =, "period" WITH &&)' in sql
        assert "PENDING_PAYMENT" in sql and "COMPLETED" not in sql

    def test_period_check_statement(self, editor):
        sql = self.ddl(editor, "booking_period_valid")
        for fragment in (
            "isempty",
            "LOWER_INC",
            "NOT UPPER_INC",
            'lower("period")',
            'upper("period")',
        ):
            assert fragment in sql


class TestGuardGaps:
    def test_bulk_create_cannot_smuggle_in_a_non_initial_status(
        self, driver, vehicle, world, window
    ):
        row = Booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            vehicle_plate="01A111AA",
            period=make_period(*window),
            amount=Decimal("1"),
            status=BookingStatus.CONFIRMED,
        )
        with pytest.raises(StatusWriteForbidden):
            Booking.objects.bulk_create([row])

    def test_bulk_create_of_pending_rows_works_and_derives_the_scalar_columns(
        self, driver, vehicle, world, window
    ):
        row = Booking(
            user=driver,
            slot=world.slots[0],
            vehicle=vehicle,
            vehicle_plate="01A111AA",
            period=make_period(*window),
            amount=Decimal("1"),
        )
        Booking.objects.bulk_create([row])
        assert Booking.objects.get(pk=row.pk).ends_at == window[1]

    def test_a_partial_refresh_does_not_move_the_status_baseline(self, booking):
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=BookingStatus.CONFIRMED)
        booking.status = BookingStatus.CONFIRMED  # an unauthorised in-memory edit
        booking.refresh_from_db(fields=["amount"])  # must NOT bless the edit
        with pytest.raises(StatusWriteForbidden):
            booking.save()

    def test_a_refresh_of_the_status_field_does_move_it(self, booking):
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=BookingStatus.CONFIRMED)
        booking.refresh_from_db(fields=["status"])
        booking.amount = Decimal("2")
        booking.save()

    def test_save_arguments_are_keyword_only(self, booking):
        with pytest.raises(TypeError):
            booking.save(False, False, None, ["status"])

    def test_update_fields_may_be_any_iterable(self, booking):
        booking.amount = Decimal("3")
        booking.save(update_fields=iter(["amount"]))
        assert Booking.objects.get(pk=booking.pk).amount == Decimal("3.00")

    def test_unknown_status_is_refused_by_the_database(self, booking):
        with pytest.raises(IntegrityError), transaction.atomic():
            with status_write_allowed():
                Booking.objects.filter(pk=booking.pk).update(status="WHATEVER")


class TestIndexesAndConstraints:
    def test_partial_indexes_for_the_hot_paths(self):
        names = {i.name: i for i in Booking._meta.indexes}
        assert names["booking_live_slot_start"].condition is not None
        assert names["booking_pending_hold"].condition is not None
        assert "booking_slot_start" not in names  # superseded by the partial one

    def test_vehicle_exclusion_constraint_is_declared(self):
        constraint = next(
            c for c in Booking._meta.constraints if c.name == "booking_vehicle_no_overlap"
        )
        assert [(str(e), op) for e, op in constraint.expressions] == [
            ("vehicle_plate", "="),
            ("period", "&&"),
        ]


def test_migration_0004_clamps_refunds_that_exceed_paid_before_adding_the_check():
    """Existing rows must not break `ADD CONSTRAINT refund <= paid`."""
    import importlib
    from unittest import mock

    module = importlib.import_module(
        "apps.bookings.migrations.0004_booking_payment_provider_refund_within_paid"
    )
    model = mock.MagicMock()
    apps = mock.Mock(get_model=mock.Mock(return_value=model))
    module.clamp_refund_to_paid(apps, None)
    apps.get_model.assert_called_once_with("bookings", "Booking")
    update = model.objects.filter.return_value.update
    assert update.called  # sets refund_amount = paid_amount where refund_amount > paid_amount
    operations = [type(op).__name__ for op in module.Migration.operations]
    assert operations.index("RunPython") < operations.index("AddConstraint")
