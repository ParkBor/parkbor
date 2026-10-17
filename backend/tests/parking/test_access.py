"""Who may run a lot's operator functions (apps.parking.access)."""

import pytest
from django.utils import timezone

from apps.parking import access
from apps.parking.models import LotStatus, OperatorAssignment, ParkingLot
from tests.helpers import make_lot, make_user

pytestmark = pytest.mark.django_db


@pytest.fixture
def owner():
    return make_user("OWNER")


@pytest.fixture
def lot(owner):
    return make_lot(owner, status=LotStatus.ACTIVE)


def assign(user, lot, **extra):
    return OperatorAssignment.objects.create(operator=user, parking_lot=lot, **extra)


def test_assigned_operator_may_operate_an_active_lot(lot):
    operator = make_user("OPERATOR")
    assign(operator, lot)

    assert access.get_operable_lot(operator, lot.pk).pk == lot.pk
    assert list(access.operable_lots(operator)) == [lot]


def test_operator_of_another_lot_may_not(lot, owner):
    operator = make_user("OPERATOR")
    assign(operator, make_lot(owner, "Other", status=LotStatus.ACTIVE))

    assert access.get_operable_lot(operator, lot.pk) is None
    assert lot not in access.operable_lots(operator)


def test_revoked_assignment_gives_nothing(lot):
    operator = make_user("OPERATOR")
    assign(operator, lot, revoked_at=timezone.now())

    assert access.get_operable_lot(operator, lot.pk) is None


def test_inactive_user_or_wrong_role_gives_nothing(lot):
    inactive = make_user("OPERATOR", is_active=False)
    demoted = make_user("DRIVER")
    assign(inactive, lot)
    assign(demoted, lot)

    assert access.get_operable_lot(inactive, lot.pk) is None
    assert access.get_operable_lot(demoted, lot.pk) is None


@pytest.mark.parametrize("status", [LotStatus.PENDING_REVIEW, LotStatus.SUSPENDED])
def test_lot_must_be_active_for_everyone(owner, status):
    lot = make_lot(owner, status=status)
    operator = make_user("OPERATOR")
    assign(operator, lot)

    assert access.get_operable_lot(operator, lot.pk) is None
    assert access.get_operable_lot(owner, lot.pk) is None
    assert access.get_operable_lot(make_user("ADMIN"), lot.pk) is None


def test_owner_operates_only_own_lots(lot, owner):
    stranger = make_user("OWNER")

    assert access.get_operable_lot(owner, lot.pk).pk == lot.pk
    assert access.get_operable_lot(stranger, lot.pk) is None


def test_admin_operates_every_active_lot(lot):
    admin = make_user("ADMIN")

    assert access.get_operable_lot(admin, lot.pk).pk == lot.pk
    assert ParkingLot.objects.filter(pk__in=access.operable_lots(admin)).count() == 1


def test_driver_and_anonymous_never(lot):
    from django.contrib.auth.models import AnonymousUser

    assert access.get_operable_lot(make_user("DRIVER"), lot.pk) is None
    assert access.get_operable_lot(AnonymousUser(), lot.pk) is None


def test_has_active_assignment(lot):
    operator = make_user("OPERATOR")
    assert not access.has_active_assignment(operator.pk, lot.pk)
    row = assign(operator, lot)
    assert access.has_active_assignment(operator.pk, lot.pk)
    row.revoked_at = timezone.now()
    row.save()
    assert not access.has_active_assignment(operator.pk, lot.pk)
