"""Staff management obeys the shared lock rules: lot first, deadlock retried once, lock waits are
a retryable 503 (not a 500), and the wait is bounded."""

from unittest import mock

import pytest
from django.db import OperationalError

from apps.bookings import services as booking_services
from apps.core.exceptions import ApiError
from apps.operators import services as operator_services
from apps.parking.models import LotStatus, OperatorAssignment
from tests.bookings.factories import FakePgError
from tests.helpers import make_lot, make_user

pytestmark = pytest.mark.django_db


def pg_error(sqlstate):
    error = OperationalError(sqlstate)
    error.__cause__ = FakePgError(sqlstate)
    return error


@pytest.fixture(autouse=True)
def _no_sleep():
    with mock.patch.object(booking_services.time, "sleep"):
        yield


@pytest.fixture
def owner():
    return make_user("OWNER")


@pytest.fixture
def lot(owner):
    return make_lot(owner, "Locked", status=LotStatus.ACTIVE)


def staffed(lot, owner):
    staff = make_user("DRIVER")
    operator_services.accept_invite(
        user=staff, code=operator_services.create_invite(lot=lot, actor=owner)[1]
    )
    return staff, OperatorAssignment.objects.get(operator=staff).pk


def test_create_invite_retries_one_deadlock(lot, owner):
    real = operator_services.lock_lot
    with mock.patch.object(
        operator_services, "lock_lot", side_effect=[pg_error("40P01"), real(lot.pk)]
    ):
        invite, code = operator_services.create_invite(lot=lot, actor=owner)

    assert invite.parking_lot_id == lot.id and code


def test_accept_retries_one_deadlock(lot, owner):
    code = operator_services.create_invite(lot=lot, actor=owner)[1]
    real = operator_services.lock_lot
    staff = make_user("DRIVER")
    with mock.patch.object(
        operator_services, "lock_lot", side_effect=[pg_error("40P01"), real(lot.pk)]
    ):
        assert operator_services.accept_invite(user=staff, code=code).pk == lot.pk

    assert OperatorAssignment.objects.filter(operator=staff).count() == 1


def test_revoke_retries_one_deadlock(lot, owner):
    _staff, assignment = staffed(lot, owner)
    real = operator_services.lock_lot
    with mock.patch.object(
        operator_services, "lock_lot", side_effect=[pg_error("40P01"), real(lot.pk)]
    ):
        operator_services.revoke_operator(lot=lot, assignment_id=assignment, actor=owner)

    assert OperatorAssignment.objects.get(pk=assignment).revoked_at is not None


@pytest.mark.parametrize("call", ["create", "accept", "revoke", "revoke_invite"])
def test_a_second_deadlock_is_a_503_serialization_retry(lot, owner, call):
    invite, code = operator_services.create_invite(lot=lot, actor=owner)
    _staff, assignment = staffed(lot, owner)
    calls = {
        "create": lambda: operator_services.create_invite(lot=lot, actor=owner),
        "accept": lambda: operator_services.accept_invite(user=make_user("DRIVER"), code=code),
        "revoke": lambda: operator_services.revoke_operator(
            lot=lot, assignment_id=assignment, actor=owner
        ),
        "revoke_invite": lambda: operator_services.revoke_invite(
            lot=lot, invite_id=invite.pk, actor=owner
        ),
    }

    with mock.patch.object(operator_services, "lock_lot", side_effect=pg_error("40P01")):
        with pytest.raises(ApiError) as exc:
            calls[call]()

    assert (exc.value.status_code, str(exc.value.detail["code"])) == (503, "serialization_retry")


def test_a_lock_wait_that_ran_out_is_503_lock_timeout_without_a_retry(lot, owner):
    with mock.patch.object(operator_services, "lock_lot", side_effect=pg_error("55P03")) as locked:
        with pytest.raises(ApiError) as exc:
            operator_services.create_invite(lot=lot, actor=owner)

    assert (exc.value.status_code, str(exc.value.detail["code"])) == (503, "lock_timeout")
    assert locked.call_count == 1


def test_every_write_bounds_its_lock_wait(lot, owner):
    seen = []
    real = booking_services.set_local_timeouts
    code = operator_services.create_invite(lot=lot, actor=owner)[1]
    _staff, assignment = staffed(lot, owner)

    def spy(seconds, statement=None):
        seen.append(seconds)
        return real(seconds, statement)

    with mock.patch.object(operator_services.booking_services, "set_local_timeouts", spy):
        operator_services.create_invite(lot=lot, actor=owner)
        operator_services.accept_invite(user=make_user("DRIVER"), code=code)
        operator_services.revoke_operator(lot=lot, assignment_id=assignment, actor=owner)

    assert len(seen) == 3 and all(isinstance(seconds, int) and seconds > 0 for seconds in seen)
