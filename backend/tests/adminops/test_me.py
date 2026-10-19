import pytest

from tests.adminops.conftest import bearer
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


def test_me_tells_the_ui_whether_the_account_is_the_super_admin(super_admin, admin, driver):
    assert bearer(super_admin).get("/api/v1/me").data["is_superuser"] is True
    assert bearer(admin).get("/api/v1/me").data["is_superuser"] is False
    assert bearer(driver).get("/api/v1/me").data["is_superuser"] is False


def test_is_superuser_cannot_be_changed_through_the_profile(driver):
    response = bearer(driver).patch(
        "/api/v1/me", {"is_superuser": True, "first_name": "X"}, format="json"
    )
    assert response.status_code == 200
    driver.refresh_from_db()
    assert driver.is_superuser is False and driver.first_name == "X"


def test_other_roles_report_false():
    assert bearer(make_user("OWNER")).get("/api/v1/me").data["is_superuser"] is False
