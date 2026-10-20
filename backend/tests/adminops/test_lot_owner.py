"""ADMIN names a lot's owner by Telegram id: create / promote / refuse, audit, login afterwards."""

import pytest
from rest_framework.test import APIClient

from apps.accounts import services as account_services
from apps.accounts.models import User
from apps.adminpanel import services as admin_services
from apps.audit.models import AuditLog
from apps.parking.models import ParkingLot
from tests.adminops.conftest import BASE, bearer
from tests.helpers import make_user
from tests.telegram_bot.test_auth_api import BASE as AUTH_BASE
from tests.telegram_bot.test_auth_api import widget_payload

pytestmark = pytest.mark.django_db

TG = 880001
LOT = {"name": "New lot", "address": "Tashkent", "location": {"lat": 41.31, "lng": 69.24}}


def create(client, **extra):
    return client.post(f"{BASE}/parkings", {**LOT, **extra}, format="json")


def test_unknown_id_pre_creates_an_owner_account(admin):
    response = create(bearer(admin), owner_telegram_id=TG)
    assert response.status_code == 201, response.data
    owner = User.objects.get(telegram_id=TG)
    assert owner.role == "OWNER" and not owner.has_usable_password() and owner.is_active
    assert ParkingLot.objects.get().owner_id == owner.pk
    assert response.data["owner"] == owner.pk and response.data["owner_telegram_id"] == TG
    row = AuditLog.objects.get(action="user.owner_created")
    assert row.actor_id == admin.pk and row.target_id == str(owner.pk)
    assert row.meta["after"]["telegram_id"] == TG and "_dropped" not in row.meta["after"]


def test_driver_is_promoted_and_audited(admin):
    driver = make_user("DRIVER", telegram_username="dilya")
    assert create(bearer(admin), owner_telegram_id=driver.telegram_id).status_code == 201
    driver.refresh_from_db()
    assert driver.role == "OWNER"
    row = AuditLog.objects.get(action="user.role_change")
    assert row.meta["before"]["role"] == "DRIVER" and row.meta["after"]["role"] == "OWNER"


@pytest.mark.parametrize("role", ["OWNER", "ADMIN"])
def test_owner_and_admin_are_used_as_they_are(admin, role):
    person = make_user(role)
    assert create(bearer(admin), owner_telegram_id=person.telegram_id).status_code == 201
    assert ParkingLot.objects.get().owner_id == person.pk
    assert User.objects.get(pk=person.pk).role == role
    assert not AuditLog.objects.filter(action__startswith="user.").exists()


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [({"role": "OPERATOR"}, "owner_role_not_allowed"), ({"is_active": False}, "owner_inactive")],
)
def test_refused_accounts_stay_untouched(admin, kwargs, code):
    person = make_user(kwargs.get("role", "DRIVER"), is_active=kwargs.get("is_active", True))
    response = create(bearer(admin), owner_telegram_id=person.telegram_id)
    assert response.status_code == 400 and response.data["code"] == code
    person.refresh_from_db()
    assert (person.role, person.is_active) == (
        kwargs.get("role", "DRIVER"),
        kwargs.get("is_active", True),
    )
    assert (
        not ParkingLot.objects.exists()
        and not AuditLog.objects.filter(action__startswith="user.").exists()
    )


def test_both_owner_and_telegram_id_is_ambiguous(admin, owner_a):
    response = create(bearer(admin), owner=str(owner_a.pk), owner_telegram_id=TG)
    assert response.status_code == 400 and response.data["code"] == "owner_ambiguous"
    assert not User.objects.filter(telegram_id=TG).exists()


@pytest.mark.parametrize("value", [0, -5, "abc", 1.5, None])
def test_bad_telegram_ids_are_400(admin, value):
    assert create(bearer(admin), owner_telegram_id=value).status_code == 400
    assert not ParkingLot.objects.exists()


def test_owner_uuid_still_works_and_default_owner_is_the_admin(admin, owner_a):
    assert create(bearer(admin), owner=str(owner_a.pk)).data["owner"] == owner_a.pk
    assert create(bearer(admin)).data["owner"] == admin.pk


def test_transfer_by_patch(admin, world_a):
    response = bearer(admin).patch(
        f"{BASE}/parkings/{world_a.lot.pk}", {"owner_telegram_id": TG}, format="json"
    )
    assert response.status_code == 200
    assert ParkingLot.objects.get(pk=world_a.lot.pk).owner.telegram_id == TG
    refused = bearer(admin).patch(
        f"{BASE}/parkings/{world_a.lot.pk}",
        {"owner_telegram_id": make_user("OPERATOR").telegram_id},
        format="json",
    )
    assert refused.status_code == 400
    assert ParkingLot.objects.get(pk=world_a.lot.pk).owner.telegram_id == TG


def test_an_owner_cannot_use_it_and_never_sees_telegram_ids(owner_a, world_a, owner_b):
    client = bearer(owner_a)
    response = create(client, owner_telegram_id=TG)
    assert response.status_code == 201 and "owner_telegram_id" not in response.data
    assert response.data["owner"] == owner_a.pk and not User.objects.filter(telegram_id=TG).exists()
    patched = client.patch(
        f"{BASE}/parkings/{world_a.lot.pk}",
        {"owner_telegram_id": owner_b.telegram_id},
        format="json",
    )
    assert (
        patched.status_code == 200
        and ParkingLot.objects.get(pk=world_a.lot.pk).owner_id == owner_a.pk
    )
    assert "owner_telegram_id" not in client.get(f"{BASE}/parkings").data["results"][0]


def test_admin_sees_the_id_in_lists_with_a_constant_query_count(
    admin, world_a, world_b, django_assert_max_num_queries
):
    with django_assert_max_num_queries(5):
        rows = bearer(admin).get(f"{BASE}/parkings").data["results"]
    assert {r["owner_telegram_id"] for r in rows} == {
        world_a.owner.telegram_id,
        world_b.owner.telegram_id,
    }


def test_double_create_of_the_same_new_id_makes_one_account(admin, monkeypatch):
    make_user("DRIVER")  # unrelated
    real = admin_services._owner_account
    calls = {"n": 0}

    def racing(telegram_id):
        calls["n"] += 1
        if calls["n"] == 1:  # the other request committed between our read and our insert
            User.objects.create_user(telegram_id, None, role="OWNER")
            return None
        return real(telegram_id)

    monkeypatch.setattr(admin_services, "_owner_account", racing)
    response = create(bearer(admin), owner_telegram_id=TG)
    assert response.status_code == 201
    assert User.objects.filter(telegram_id=TG).count() == 1
    assert ParkingLot.objects.get().owner.telegram_id == TG


def test_second_request_for_the_same_id_reuses_the_account(admin):
    client = bearer(admin)
    assert create(client, owner_telegram_id=TG).status_code == 201
    assert create(client, owner_telegram_id=TG).status_code == 201
    assert User.objects.filter(telegram_id=TG).count() == 1
    assert AuditLog.objects.filter(action="user.owner_created").count() == 1


# --- the owner signs in later ---------------------------------------------------------------------


def test_first_widget_login_lands_on_the_pre_created_owner_and_fills_the_name(admin):
    create(bearer(admin), owner_telegram_id=TG)
    pre = User.objects.get(telegram_id=TG)
    response = APIClient().post(
        f"{AUTH_BASE}/widget", widget_payload(telegram_id=TG), format="json"
    )
    assert response.status_code == 200 and response.json()["user"]["role"] == "OWNER"
    pre.refresh_from_db()
    assert (pre.first_name, pre.telegram_username) == ("Ali", "ali")
    assert User.objects.filter(telegram_id=TG).count() == 1


def test_bot_login_keeps_the_owner_role_and_fills_names_without_overwriting(admin):
    create(bearer(admin), owner_telegram_id=TG)
    result = account_services.login_with_telegram(
        telegram_id=TG, phone="+998901112299", username="olim", first_name="Olim", last_name="K"
    )
    assert result.is_new is False and result.user.role == "OWNER"
    assert (result.user.first_name, result.user.last_name) == ("Olim", "K")
    again = account_services.login_with_telegram(
        telegram_id=TG, phone="+998901112299", username="olim2", first_name="Other", last_name="Z"
    )
    assert (again.user.first_name, again.user.last_name) == ("Olim", "K")
