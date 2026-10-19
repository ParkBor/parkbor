import pytest
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.parking.models import OperatorAssignment
from tests.adminops.conftest import BASE, bearer
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


def patch(actor, target, body):
    return bearer(actor).patch(f"{BASE}/users/{target.pk}", body, format="json")


def test_list_has_no_phone_and_filters_by_role_active_and_search(admin, driver):
    make_user("OWNER", first_name="Olim", is_active=False)
    client = bearer(admin)
    rows = client.get(f"{BASE}/users").data["results"]
    assert set(rows[0]) == {
        "id",
        "telegram_username",
        "first_name",
        "last_name",
        "role",
        "is_active",
        "created_at",
    }
    assert [r["id"] for r in client.get(f"{BASE}/users", {"role": "DRIVER"}).data["results"]] == [
        str(driver.pk)
    ]
    inactive = client.get(f"{BASE}/users", {"is_active": "false"}).data["results"]
    assert [r["first_name"] for r in inactive] == ["Olim"]
    found = client.get(f"{BASE}/users", {"search": "dily"}).data["results"]
    assert [r["id"] for r in found] == [str(driver.pk)]
    assert client.get(f"{BASE}/users", {"search": "+998901112233"}).data["count"] == 0


def test_list_query_count_is_constant(admin, django_assert_max_num_queries):
    for _ in range(15):
        make_user("DRIVER")
    with django_assert_max_num_queries(6):
        assert bearer(admin).get(f"{BASE}/users", {"page_size": 100}).status_code == 200


def test_block_unblock_is_audited_and_revokes_refresh_tokens(admin, driver):
    refresh = RefreshToken.for_user(driver)
    response = patch(admin, driver, {"is_active": False})
    assert response.status_code == 200 and response.data["is_active"] is False
    assert BlacklistedToken.objects.filter(token__user=driver).count() == 1
    assert OutstandingToken.objects.filter(user=driver).count() == 1
    row = AuditLog.objects.get(action="user.block")
    assert row.actor_id == admin.pk and row.target_id == str(driver.pk)
    assert row.target_type == "user"
    assert row.meta["after"]["is_active"] is False
    assert bearer(driver).get("/api/v1/me").status_code == 401  # access token dies at once
    assert str(refresh)  # token object still constructible; only the blacklist matters
    patch(admin, driver, {"is_active": True})
    assert AuditLog.objects.filter(action="user.unblock").count() == 1
    assert User.objects.get(pk=driver.pk).is_active


def test_noop_change_writes_no_audit(admin, driver):
    assert patch(admin, driver, {"is_active": True, "role": "DRIVER"}).status_code == 200
    assert not AuditLog.objects.filter(action__startswith="user.").exists()


def test_role_change_is_audited(admin, driver):
    assert patch(admin, driver, {"role": "OWNER"}).data["role"] == "OWNER"
    row = AuditLog.objects.get(action="user.role_change")
    assert row.meta["before"]["role"] == "DRIVER" and row.meta["after"]["role"] == "OWNER"


@pytest.mark.parametrize(
    "body", [{}, {"role": "ROOT"}, {"is_superuser": True}, {"role": "OWNER", "phone": "1"}]
)
def test_invalid_bodies_are_400(admin, driver, body):
    assert patch(admin, driver, body).status_code == 400
    driver.refresh_from_db()
    assert driver.role == "DRIVER" and not driver.is_superuser


def test_unknown_user_is_404(admin):
    import uuid

    response = bearer(admin).patch(
        f"{BASE}/users/{uuid.uuid4()}", {"is_active": False}, format="json"
    )
    assert response.status_code == 404


def test_cannot_act_on_self(admin):
    for body in ({"is_active": False}, {"role": "DRIVER"}):
        response = patch(admin, admin, body)
        assert response.status_code == 403 and response.data["code"] == "cannot_modify_self"


def test_super_admin_is_protected(admin, super_admin):
    response = patch(admin, super_admin, {"is_active": False})
    assert response.status_code == 403 and response.data["code"] == "super_admin_protected"
    assert User.objects.get(pk=super_admin.pk).is_active


def test_only_super_admin_grants_admin_or_touches_admins(admin, super_admin, driver):
    other_admin = make_user("ADMIN")
    for target, body in ((driver, {"role": "ADMIN"}), (other_admin, {"is_active": False})):
        response = patch(admin, target, body)
        assert response.status_code == 403 and response.data["code"] == "super_admin_required"
    assert patch(super_admin, driver, {"role": "ADMIN"}).status_code == 200
    assert patch(super_admin, other_admin, {"is_active": False}).status_code == 200


def test_last_admin_guard_in_the_service():
    from apps.adminpanel import services

    # An actor who was blocked a moment ago must not be able to remove the only active admin.
    actor = make_user("ADMIN", is_superuser=True, is_active=False)
    target = make_user("ADMIN")
    with pytest.raises(services.LastAdmin):
        services.update_user(actor=actor, user_id=target.pk, role="DRIVER")
    with pytest.raises(services.LastAdmin):
        services.update_user(actor=actor, user_id=target.pk, is_active=False)
    assert User.objects.get(pk=target.pk).role == "ADMIN"


def test_owner_with_lots_cannot_lose_the_role(admin, owner_a, world_a):
    response = patch(admin, owner_a, {"role": "DRIVER"})
    assert response.status_code == 409 and response.data["code"] == "owner_has_parkings"
    lone = make_user("OWNER")
    assert patch(admin, lone, {"role": "DRIVER"}).status_code == 200


def test_leaving_the_operator_role_ends_assignments(admin, owner_a, world_a):
    from apps.operators import services as operator_services

    staff = make_user("DRIVER")
    _invite, code = operator_services.create_invite(lot=world_a.lot, actor=owner_a, hours=1)
    operator_services.accept_invite(user=staff, code=code)
    staff.refresh_from_db()
    assert staff.role == "OPERATOR"
    assert patch(admin, staff, {"role": "DRIVER"}).status_code == 200
    assert not OperatorAssignment.objects.filter(operator=staff, revoked_at__isnull=True).exists()
