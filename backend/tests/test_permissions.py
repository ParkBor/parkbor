from types import SimpleNamespace as NS
from uuid import uuid4

import pytest
from rest_framework.test import APIRequestFactory

from apps.accounts.models import User
from apps.core import permissions
from apps.core.permissions import IsOwnerOfLot, IsSuperAdmin, lot_owner_id
from apps.parking.models import ParkingLot, Slot, Tariff, Zone


def user(role, pk=None, is_active=True):
    return NS(pk=pk or uuid4(), role=role, is_authenticated=True, is_active=is_active)


def req(u):
    request = APIRequestFactory().get("/")
    request.user = u
    return request


ANON = NS(pk=None, role=None, is_authenticated=False)


class TestIsSuperAdmin:
    def test_admin_allowed(self):
        assert IsSuperAdmin().has_permission(req(user("ADMIN")), None)

    @pytest.mark.parametrize("role", ["OWNER", "OPERATOR", "DRIVER", None])
    def test_others_denied(self, role):
        assert not IsSuperAdmin().has_permission(req(user(role)), None)

    def test_anonymous_denied(self):
        assert not IsSuperAdmin().has_permission(req(ANON), None)

    def test_inactive_admin_denied(self):
        assert not IsSuperAdmin().has_permission(req(user("ADMIN", is_active=False)), None)


class TestIsOwnerOfLot:
    def test_owner_has_permission(self):
        assert IsOwnerOfLot().has_permission(req(user("OWNER")), None)

    @pytest.mark.parametrize("role", ["ADMIN", "OPERATOR", "DRIVER"])
    def test_non_owner_roles_denied(self, role):
        assert not IsOwnerOfLot().has_permission(req(user(role)), None)

    def test_object_of_own_lot_allowed(self):
        owner = user("OWNER")
        assert IsOwnerOfLot().has_object_permission(req(owner), None, ParkingLot(owner_id=owner.pk))

    def test_object_of_foreign_lot_denied(self):
        assert not IsOwnerOfLot().has_object_permission(
            req(user("OWNER")), None, ParkingLot(owner_id=uuid4())
        )

    def test_nested_objects_resolve_through_lot(self):
        owner = user("OWNER")
        lot = ParkingLot(owner_id=owner.pk)
        zone = Zone(parking_lot=lot)
        for obj in (zone, Slot(zone=zone), Tariff(parking_lot=lot)):
            assert IsOwnerOfLot().has_object_permission(req(owner), None, obj)

    def test_nested_foreign_object_denied(self):
        lot = ParkingLot(owner_id=uuid4())
        assert not IsOwnerOfLot().has_object_permission(
            req(user("OWNER")), None, Slot(zone=Zone(parking_lot=lot))
        )

    def test_unknown_object_denied(self):
        assert lot_owner_id(object()) is None
        assert not IsOwnerOfLot().has_object_permission(req(user("OWNER")), None, object())

    def test_lookalike_object_with_owner_id_is_not_trusted(self):
        owner = user("OWNER")
        lookalike = NS(owner_id=owner.pk)
        assert lot_owner_id(lookalike) is None
        assert not IsOwnerOfLot().has_object_permission(req(owner), None, lookalike)

    def test_inactive_owner_denied(self):
        inactive = user("OWNER", is_active=False)
        assert not IsOwnerOfLot().has_permission(req(inactive), None)
        assert not IsOwnerOfLot().has_object_permission(
            req(inactive), None, ParkingLot(owner_id=inactive.pk)
        )

    def test_admin_is_not_owner_of_lot(self):
        admin = user("ADMIN")
        assert not IsOwnerOfLot().has_object_permission(
            req(admin), None, ParkingLot(owner_id=admin.pk)
        )


def test_role_constants_come_from_the_user_model():
    assert permissions.ROLE_ADMIN == User.Role.ADMIN
    assert permissions.ROLE_OWNER == User.Role.OWNER
