import hashlib
import hmac
import time

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.telegram_bot import login_service as svc
from apps.telegram_bot.login_service import TelegramIdentity
from tests.auth_fixtures import BOT_TOKEN

pytestmark = pytest.mark.django_db
BASE = "/api/v1/auth/telegram"


def identity(telegram_id=777001, phone="+998901234567", username="ali"):
    return TelegramIdentity(
        telegram_id=telegram_id, phone=phone, username=username, first_name="Ali", last_name="V"
    )


def confirmed_login(ident=None):
    ident = ident or identity()
    token = svc.start_login("dev").token
    svc.bind_chat(token, ident.telegram_id)
    code = svc.confirm_contact(token, ident)
    return token, code


def verify(token, code, client=None):
    return (client or APIClient()).post(
        f"{BASE}/verify", {"login_token": token, "code": code}, format="json"
    )


# ---- start -------------------------------------------------------------------------------------


def test_start_returns_token_bot_url_and_expiry(settings):
    settings.TELEGRAM_BOT_USERNAME = "ParkBorTestBot"
    response = APIClient().post(f"{BASE}/start", {"device_id": "abc"}, format="json")
    assert response.status_code == 200
    body = response.json()
    assert body["expires_in"] == 300
    assert body["bot_url"] == f"https://t.me/ParkBorTestBot?start={body['login_token']}"
    assert svc.get_status(body["login_token"]) == "PENDING"


def test_start_works_without_device_id():
    assert APIClient().post(f"{BASE}/start", {}, format="json").status_code == 200


def test_start_rejects_oversized_device_id():
    response = APIClient().post(f"{BASE}/start", {"device_id": "x" * 500}, format="json")
    assert response.status_code == 400


def test_start_ignores_invalid_bearer_header():
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION="Bearer garbage")
    assert client.post(f"{BASE}/start", {}, format="json").status_code == 200


# ---- status ------------------------------------------------------------------------------------


def test_status_flow_pending_to_confirmed():
    token = svc.start_login().token
    client = APIClient()
    assert client.get(f"{BASE}/status", {"login_token": token}).json() == {
        "status": "PENDING",
        "needs_code": False,
    }
    svc.bind_chat(token, 777001)
    svc.confirm_contact(token, identity())
    assert client.get(f"{BASE}/status", {"login_token": token}).json() == {
        "status": "CONFIRMED",
        "needs_code": True,
    }


def test_status_unknown_token_is_expired():
    body = APIClient().get(f"{BASE}/status", {"login_token": "u" * 43}).json()
    assert body["status"] == "EXPIRED"


def test_status_requires_login_token_param():
    assert APIClient().get(f"{BASE}/status").status_code == 400


def test_status_rejects_malformed_token():
    assert APIClient().get(f"{BASE}/status", {"login_token": "a b"}).status_code == 400


# ---- verify ------------------------------------------------------------------------------------


def test_verify_creates_user_and_returns_jwt_with_is_new_true():
    token, code = confirmed_login()
    response = verify(token, code)
    assert response.status_code == 200
    body = response.json()
    assert body["is_new"] is True
    assert body["access"] and body["refresh"]
    assert body["user"]["telegram_id"] == 777001
    assert body["user"]["phone"] == "+998901234567"
    assert body["user"]["role"] == "DRIVER"
    assert "password" not in body["user"]
    user = User.objects.get(telegram_id=777001)
    assert user.telegram_username == "ali"
    assert not user.has_usable_password()


def test_verify_access_token_authenticates_me():
    token, code = confirmed_login()
    access = verify(token, code).json()["access"]
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    assert client.get("/api/v1/me").json()["telegram_id"] == 777001


def test_second_login_is_not_new_and_reuses_user():
    t1, c1 = confirmed_login()
    verify(t1, c1)
    t2, c2 = confirmed_login(identity(username="ali_new"))
    body = verify(t2, c2).json()
    assert body["is_new"] is False
    assert User.objects.count() == 1
    assert User.objects.get().telegram_username == "ali_new"


def test_relogin_updates_phone_but_keeps_profile_edits():
    t1, c1 = confirmed_login()
    verify(t1, c1)
    User.objects.filter(telegram_id=777001).update(first_name="Edited", language="ru")
    t2, c2 = confirmed_login(identity(phone="+998909999999"))
    verify(t2, c2)
    user = User.objects.get()
    assert user.phone == "+998909999999"
    assert user.first_name == "Edited"
    assert user.language == "ru"


def test_verify_wrong_code_is_400_and_creates_no_user():
    token, code = confirmed_login()
    wrong = "000000" if code != "000000" else "111111"
    response = verify(token, wrong)
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_code"
    assert not User.objects.exists()


def test_verify_code_cannot_be_replayed():
    token, code = confirmed_login()
    assert verify(token, code).status_code == 200
    assert verify(token, code).status_code == 410


def test_verify_five_wrong_codes_cancel_token():
    token, code = confirmed_login()
    wrong = "000000" if code != "000000" else "111111"
    statuses = [verify(token, wrong).status_code for _ in range(5)]
    assert statuses[:4] == [400] * 4
    assert verify(token, code).status_code == 410


def test_verify_before_bot_confirmation_is_409():
    token = svc.start_login().token
    assert verify(token, "123456").status_code == 409


def test_verify_unknown_token_is_410():
    assert verify("u" * 43, "123456").status_code == 410


@pytest.mark.parametrize("code", ["12345", "1234567", "abcdef", "", None])
def test_verify_rejects_malformed_code(code):
    token, _ = confirmed_login()
    assert verify(token, code).status_code == 400


def test_verify_inactive_user_forbidden():
    User.objects.create_user(telegram_id=777001, is_active=False)
    token, code = confirmed_login()
    assert verify(token, code).status_code == 403


def test_verify_phone_owned_by_other_account_is_409():
    User.objects.create_user(telegram_id=1, phone="+998901234567")
    token, code = confirmed_login(identity(telegram_id=2))
    assert verify(token, code).status_code == 409
    assert User.objects.filter(telegram_id=2).count() == 0


# ---- widget ------------------------------------------------------------------------------------


def widget_payload(telegram_id=777001, auth_date=None, bot_token=BOT_TOKEN, **extra):
    data = {
        "id": telegram_id,
        "first_name": "Ali",
        "username": "ali",
        "auth_date": auth_date if auth_date is not None else int(time.time()),
        **extra,
    }
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hashlib.sha256(bot_token.encode()).digest()
    data["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return data


def post_widget(data):
    return APIClient().post(f"{BASE}/widget", data, format="json")


@pytest.mark.parametrize("role", [User.Role.OWNER, User.Role.ADMIN])
def test_widget_valid_for_owner_and_admin(role):
    User.objects.create_user(telegram_id=777001, role=role)
    response = post_widget(widget_payload())
    assert response.status_code == 200
    body = response.json()
    assert body["access"] and body["refresh"]
    assert body["is_new"] is False
    assert body["user"]["role"] == role


def test_widget_with_photo_url_and_last_name():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    data = widget_payload(photo_url="https://t.me/i/userpic/320/x.jpg", last_name="V")
    assert post_widget(data).status_code == 200


@pytest.mark.parametrize("role", [User.Role.DRIVER, User.Role.OPERATOR])
def test_widget_forbidden_for_driver_and_operator(role):
    User.objects.create_user(telegram_id=777001, role=role)
    assert post_widget(widget_payload()).status_code == 403


def test_widget_unknown_telegram_id_forbidden_and_not_created():
    assert post_widget(widget_payload()).status_code == 403
    assert not User.objects.exists()


def test_widget_inactive_admin_forbidden():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN, is_active=False)
    assert post_widget(widget_payload()).status_code == 403


def test_widget_bad_hash_rejected():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    data = widget_payload()
    data["hash"] = "0" * 64
    assert post_widget(data).status_code == 400


def test_widget_signed_with_other_bot_token_rejected():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    assert post_widget(widget_payload(bot_token="1:OTHER")).status_code == 400


def test_widget_stale_auth_date_rejected():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    old = int(time.time()) - 300 - 60
    assert post_widget(widget_payload(auth_date=old)).status_code == 400


def test_widget_tampered_id_rejected_even_if_target_is_admin():
    User.objects.create_user(telegram_id=777001, role=User.Role.DRIVER)
    User.objects.create_user(telegram_id=1, role=User.Role.ADMIN)
    data = widget_payload()
    data["id"] = 1
    assert post_widget(data).status_code == 400


def test_widget_missing_fields_400():
    assert post_widget({"id": 1}).status_code == 400


# ---- throttle ----------------------------------------------------------------------------------


def test_start_is_throttled_to_10_per_minute_per_ip():
    client = APIClient()
    codes = [client.post(f"{BASE}/start", {}, format="json").status_code for _ in range(11)]
    assert codes[:10] == [200] * 10
    assert codes[10] == 429


def test_throttle_is_per_ip():
    a = APIClient(REMOTE_ADDR="10.0.0.1")
    b = APIClient(REMOTE_ADDR="10.0.0.2")
    for _ in range(10):
        a.post(f"{BASE}/start", {}, format="json")
    assert a.post(f"{BASE}/start", {}, format="json").status_code == 429
    assert b.post(f"{BASE}/start", {}, format="json").status_code == 200


def test_throttle_applies_to_verify_and_widget():
    client = APIClient()
    for call in (
        lambda: client.post(
            f"{BASE}/verify", {"login_token": "u" * 43, "code": "123456"}, format="json"
        ),
        lambda: client.post(f"{BASE}/widget", {"id": 1}, format="json"),
    ):
        codes = [call().status_code for _ in range(11)]
        assert codes[-1] == 429


def test_spoofed_x_forwarded_for_does_not_bypass_throttle():
    client = APIClient()
    codes = [
        client.post(
            f"{BASE}/start", {}, format="json", HTTP_X_FORWARDED_FOR=f"1.2.3.{i}"
        ).status_code
        for i in range(11)
    ]
    assert codes[-1] == 429
