"""Deny-by-default access, token handling, caching headers, paging limits, nested ownership."""

import uuid

import pytest
from django.conf import settings
from rest_framework.test import APIClient

from apps.operators import services as operator_services
from apps.parking.models import OperatorAssignment, OperatorInvite
from apps.core.pagination import StandardPagination
from tests.adminops.conftest import BASE, bearer
from tests.helpers import client_for, make_user

pytestmark = pytest.mark.django_db

ANY = uuid.uuid4()
ADMIN_ONLY_GET = ["users", "settings", "audit-logs"]
STAFF_GET = [
    "bookings",
    "payments",
    "refunds",
    "reviews",
    "stats/overview",
    "stats/revenue",
    "stats/occupancy",
]
ADMIN_ONLY_WRITE = [
    ("patch", f"users/{ANY}", {"is_active": False}),
    ("patch", "settings", {"hold_minutes": 5}),
    ("post", f"refunds/{ANY}/resolve", {"outcome": "done"}),
    ("post", f"reviews/{ANY}/hide", None),
    ("post", f"reviews/{ANY}/publish", None),
    ("post", f"parkings/{ANY}/approve", None),
    ("post", f"parkings/{ANY}/suspend", None),
    ("post", f"parkings/{ANY}/restore", None),
]


@pytest.mark.parametrize("path", ADMIN_ONLY_GET + STAFF_GET)
def test_anonymous_is_401(path):
    assert APIClient().get(f"{BASE}/{path}").status_code == 401


@pytest.mark.parametrize("role", ["DRIVER", "OPERATOR"])
@pytest.mark.parametrize("path", ADMIN_ONLY_GET + STAFF_GET)
def test_driver_and_operator_tokens_are_rejected(role, path):
    assert bearer(make_user(role)).get(f"{BASE}/{path}").status_code == 403


@pytest.mark.parametrize("path", ADMIN_ONLY_GET)
def test_owner_cannot_read_admin_only_resources(owner_a, path):
    assert bearer(owner_a).get(f"{BASE}/{path}").status_code == 403


@pytest.mark.parametrize(("method", "path", "body"), ADMIN_ONLY_WRITE)
def test_owner_cannot_use_admin_only_actions(owner_a, method, path, body):
    response = getattr(bearer(owner_a), method)(f"{BASE}/{path}", body, format="json")
    assert response.status_code == 403


@pytest.mark.parametrize(("method", "path", "body"), ADMIN_ONLY_WRITE)
def test_driver_cannot_use_admin_only_actions(driver, method, path, body):
    response = getattr(bearer(driver), method)(f"{BASE}/{path}", body, format="json")
    assert response.status_code == 403


def test_blocked_admin_token_stops_working(admin):
    client = bearer(admin)
    assert client.get(f"{BASE}/settings").status_code == 200
    admin.is_active = False
    admin.save(update_fields=["is_active"])
    assert client.get(f"{BASE}/settings").status_code == 401


def test_inactive_staff_is_denied_even_when_force_authenticated(owner_a):
    owner_a.is_active = False
    owner_a.save(update_fields=["is_active"])
    assert client_for(owner_a).get(f"{BASE}/bookings").status_code == 403


def test_authentication_is_bearer_only_so_there_is_no_csrf_surface():
    classes = settings.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"]
    assert [cls.rsplit(".", 1)[-1] for cls in classes] == ["JWTAuthentication"]


@pytest.mark.parametrize("path", [*ADMIN_ONLY_GET, *STAFF_GET, "parkings", "zones"])
def test_every_admin_response_is_no_store(admin, path):
    assert bearer(admin).get(f"{BASE}/{path}").headers["Cache-Control"] == "no-store"


def test_errors_are_no_store_too(driver):
    response = bearer(driver).get(f"{BASE}/users")
    assert response.status_code == 403
    assert response.headers["Cache-Control"] == "no-store"
    assert APIClient().get(f"{BASE}/users").headers["Cache-Control"] == "no-store"


def test_page_size_is_capped_at_100_on_the_server(admin):
    assert StandardPagination.max_page_size == 100
    response = bearer(admin).get(f"{BASE}/users", {"page_size": 100000})
    assert response.status_code == 200


def test_list_endpoints_are_throttled(admin, monkeypatch):
    from rest_framework.throttling import SimpleRateThrottle

    rates = {**SimpleRateThrottle.THROTTLE_RATES, "admin_read": "2/min"}
    monkeypatch.setattr(SimpleRateThrottle, "THROTTLE_RATES", rates)
    client = bearer(admin)
    assert [client.get(f"{BASE}/payments").status_code for _ in range(3)] == [200, 200, 429]


# --- nested ownership: operators and invites ---------------------------------------------------


def _assignment(lot, owner):
    staff = make_user("DRIVER", first_name="Aziza", last_name="Karimova")
    _invite, code = operator_services.create_invite(lot=lot, actor=owner, hours=1)
    operator_services.accept_invite(user=staff, code=code)
    return OperatorAssignment.objects.get(parking_lot=lot, operator=staff)


def test_owner_cannot_revoke_operator_through_a_foreign_lot(owner_a, owner_b, world_a, world_b):
    assignment = _assignment(world_b.lot, owner_b)
    client = bearer(owner_a)
    own_lot = f"{BASE}/parkings/{world_a.lot.pk}/operators/{assignment.pk}"
    foreign_lot = f"{BASE}/parkings/{world_b.lot.pk}/operators/{assignment.pk}"
    assert client.delete(own_lot).status_code == 404
    assert client.delete(foreign_lot).status_code == 404
    assignment.refresh_from_db()
    assert assignment.revoked_at is None
    assert bearer(owner_b).delete(foreign_lot).status_code == 204


def test_owner_cannot_revoke_a_foreign_invite(owner_a, owner_b, world_a, world_b):
    invite, _code = operator_services.create_invite(lot=world_b.lot, actor=owner_b, hours=1)
    client = bearer(owner_a)
    for lot in (world_a.lot, world_b.lot):
        client.delete(f"{BASE}/parkings/{lot.pk}/operator-invites/{invite.pk}")
    assert OperatorInvite.objects.get(pk=invite.pk).revoked_at is None


def test_operator_list_name_is_masked_for_owner_and_null_for_admin(owner_a, admin, world_a):
    _assignment(world_a.lot, owner_a)
    url = f"{BASE}/parkings/{world_a.lot.pk}/operators"
    owner_row = bearer(owner_a).get(url).data["results"][0]
    admin_row = bearer(admin).get(url).data["results"][0]
    assert owner_row["display_name"] == "Aziza K."
    assert admin_row["display_name"] is None
    assert set(owner_row) == {"id", "assignment_id", "display_name", "created_at"}


def test_owner_filter_by_a_foreign_lot_is_rejected(owner_a, world_b):
    response = bearer(owner_a).get(f"{BASE}/bookings", {"parking_lot": str(world_b.lot.pk)})
    assert response.status_code == 400
