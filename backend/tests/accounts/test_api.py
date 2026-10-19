import io
from datetime import timedelta

import pytest
from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from freezegun import freeze_time
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.models import Device, User

pytestmark = pytest.mark.django_db
API = "/api/v1"
TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"
TOKEN_B = "ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]"


def auth_client(user):
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(user).access_token}")
    return client


@pytest.fixture
def user():
    return User.objects.create_user(
        telegram_id=1001, phone="+998901234567", first_name="Ali", telegram_username="ali"
    )


# ---- jwt behaviour -----------------------------------------------------------------------------


def test_access_token_lives_15_minutes(user):
    with freeze_time("2026-01-01 10:00:00") as clock:
        client = auth_client(user)
        clock.tick(timedelta(minutes=14, seconds=50))
        assert client.get(f"{API}/me").status_code == 200
        clock.tick(timedelta(minutes=1))
        assert client.get(f"{API}/me").status_code == 401


def test_refresh_token_lives_30_days(user):
    with freeze_time("2026-01-01 10:00:00") as clock:
        refresh = str(RefreshToken.for_user(user))
        clock.tick(timedelta(days=29))
        ok = APIClient().post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
        assert ok.status_code == 200
        clock.tick(timedelta(days=2))
        late = APIClient().post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
        assert late.status_code == 401


@pytest.mark.filterwarnings("ignore:The HMAC key")
def test_tokens_are_not_signed_with_django_secret_key(user):
    import jwt

    token = str(RefreshToken.for_user(user).access_token)
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])


def test_unauthenticated_default_is_401_not_403():
    response = APIClient().get(f"{API}/me")
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"].startswith("Bearer")


# ---- me ----------------------------------------------------------------------------------------


def test_me_requires_authentication():
    assert APIClient().get(f"{API}/me").status_code == 401


def test_me_rejects_garbage_token():
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION="Bearer nope")
    assert client.get(f"{API}/me").status_code == 401


def test_me_rejects_refresh_token_as_access(user):
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(user)}")
    assert client.get(f"{API}/me").status_code == 401


def test_me_get_returns_profile(user):
    body = auth_client(user).get(f"{API}/me").json()
    assert body["telegram_id"] == 1001
    assert body["first_name"] == "Ali"
    assert body["role"] == "DRIVER"
    assert body["language"] == "uz"
    assert "password" not in body
    assert body["is_superuser"] is False  # exposed read-only for the admin UI (Step 11b)


def test_inactive_user_token_rejected(user):
    client = auth_client(user)
    User.objects.filter(pk=user.pk).update(is_active=False)
    assert client.get(f"{API}/me").status_code == 401


def test_me_patch_updates_editable_fields(user):
    response = auth_client(user).patch(
        f"{API}/me",
        {"first_name": "Vali", "last_name": "K", "language": "ru", "tg_notifications": False},
        format="json",
    )
    assert response.status_code == 200
    user.refresh_from_db()
    assert (user.first_name, user.last_name, user.language) == ("Vali", "K", "ru")
    assert user.tg_notifications is False


def test_me_patch_cannot_escalate_or_change_identity(user):
    response = auth_client(user).patch(
        f"{API}/me",
        {
            "role": "ADMIN",
            "telegram_id": 5,
            "phone": "+1",
            "is_active": False,
            "is_superuser": True,
        },
        format="json",
    )
    assert response.status_code == 200
    user.refresh_from_db()
    assert user.role == "DRIVER"
    assert user.telegram_id == 1001
    assert user.phone == "+998901234567"
    assert user.is_active and not user.is_superuser


def test_me_patch_invalid_language(user):
    assert (
        auth_client(user).patch(f"{API}/me", {"language": "xx"}, format="json").status_code == 400
    )


def test_me_patch_rejects_overlong_name(user):
    response = auth_client(user).patch(f"{API}/me", {"first_name": "a" * 500}, format="json")
    assert response.status_code == 400


def test_me_put_not_allowed(user):
    assert auth_client(user).put(f"{API}/me", {}, format="json").status_code == 405


# ---- devices -----------------------------------------------------------------------------------


def test_register_device_creates(user):
    response = auth_client(user).post(
        f"{API}/me/devices", {"platform": "android", "expo_push_token": TOKEN_A}, format="json"
    )
    assert response.status_code == 201
    device = Device.objects.get()
    assert device.user == user and device.platform == "android"


def test_register_same_token_is_idempotent(user):
    client = auth_client(user)
    body = {"platform": "ios", "expo_push_token": TOKEN_A}
    assert client.post(f"{API}/me/devices", body, format="json").status_code == 201
    assert client.post(f"{API}/me/devices", body, format="json").status_code == 200
    assert Device.objects.count() == 1


def test_token_moves_to_new_user_on_registration(user):
    other = User.objects.create_user(telegram_id=2002)
    body = {"platform": "ios", "expo_push_token": TOKEN_A}
    auth_client(user).post(f"{API}/me/devices", body, format="json")
    auth_client(other).post(f"{API}/me/devices", body, format="json")
    assert Device.objects.get().user == other


@pytest.mark.parametrize("token", ["", "not-a-token", "ExponentPushToken[]", "x" * 400])
def test_register_rejects_invalid_token(user, token):
    response = auth_client(user).post(
        f"{API}/me/devices", {"platform": "ios", "expo_push_token": token}, format="json"
    )
    assert response.status_code == 400


def test_register_rejects_unknown_platform(user):
    response = auth_client(user).post(
        f"{API}/me/devices", {"platform": "palm", "expo_push_token": TOKEN_A}, format="json"
    )
    assert response.status_code == 400


def test_devices_require_auth():
    assert APIClient().post(f"{API}/me/devices", {}, format="json").status_code == 401
    assert APIClient().delete(f"{API}/me/devices", {}, format="json").status_code == 401


def test_delete_own_device(user):
    Device.objects.create(user=user, platform="ios", expo_push_token=TOKEN_A)
    response = auth_client(user).delete(
        f"{API}/me/devices", {"expo_push_token": TOKEN_A}, format="json"
    )
    assert response.status_code == 204
    assert Device.objects.count() == 0


def test_cannot_delete_someone_elses_device(user):
    other = User.objects.create_user(telegram_id=2002)
    Device.objects.create(user=other, platform="ios", expo_push_token=TOKEN_B)
    response = auth_client(user).delete(
        f"{API}/me/devices", {"expo_push_token": TOKEN_B}, format="json"
    )
    assert response.status_code == 204
    assert Device.objects.count() == 1


# ---- refresh / logout --------------------------------------------------------------------------


def test_refresh_rotates_and_blacklists_old_token(user):
    refresh = str(RefreshToken.for_user(user))
    client = APIClient()
    first = client.post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
    assert first.status_code == 200
    assert first.json()["access"] and first.json()["refresh"] != refresh
    reuse = client.post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
    assert reuse.status_code == 401


def test_refresh_with_invalid_token_401():
    response = APIClient().post(f"{API}/auth/token/refresh", {"refresh": "bad"}, format="json")
    assert response.status_code == 401


def test_refresh_ignores_bad_authorization_header(user):
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION="Bearer expired-garbage")
    refresh = str(RefreshToken.for_user(user))
    assert (
        client.post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json").status_code
        == 200
    )


def test_refresh_denied_for_inactive_user(user):
    refresh = str(RefreshToken.for_user(user))
    User.objects.filter(pk=user.pk).update(is_active=False)
    response = APIClient().post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
    assert response.status_code == 401


def test_logout_blacklists_refresh_token(user):
    refresh = str(RefreshToken.for_user(user))
    response = auth_client(user).post(f"{API}/auth/logout", {"refresh": refresh}, format="json")
    assert response.status_code == 204
    after = APIClient().post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
    assert after.status_code == 401


def test_logout_requires_auth(user):
    refresh = str(RefreshToken.for_user(user))
    assert (
        APIClient().post(f"{API}/auth/logout", {"refresh": refresh}, format="json").status_code
        == 401
    )


def test_logout_with_invalid_token_400(user):
    response = auth_client(user).post(f"{API}/auth/logout", {"refresh": "junk"}, format="json")
    assert response.status_code == 400


def test_logout_cannot_revoke_other_users_token(user):
    other = User.objects.create_user(telegram_id=2002)
    refresh = str(RefreshToken.for_user(other))
    response = auth_client(user).post(f"{API}/auth/logout", {"refresh": refresh}, format="json")
    assert response.status_code == 400
    ok = APIClient().post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
    assert ok.status_code == 200


def test_logout_twice_is_400(user):
    refresh = str(RefreshToken.for_user(user))
    client = auth_client(user)
    client.post(f"{API}/auth/logout", {"refresh": refresh}, format="json")
    assert client.post(f"{API}/auth/logout", {"refresh": refresh}, format="json").status_code == 400


def test_logout_missing_refresh_400(user):
    assert auth_client(user).post(f"{API}/auth/logout", {}, format="json").status_code == 400


# ---- schema ------------------------------------------------------------------------------------


def test_own_openapi_schema_is_valid_without_any_warning():
    from django.urls import include, path
    from drf_spectacular.drainage import GENERATOR_STATS
    from drf_spectacular.generators import SchemaGenerator

    patterns = [
        path("api/v1/", include("apps.accounts.urls")),
        path("api/v1/", include("apps.telegram_bot.urls")),
    ]
    GENERATOR_STATS.reset()
    schema = SchemaGenerator(patterns=patterns).get_schema(request=None, public=True)
    assert not GENERATOR_STATS, "schema warnings/errors for auth endpoints"
    paths = set(schema["paths"])
    assert {
        "/api/v1/auth/telegram/start",
        "/api/v1/auth/telegram/status",
        "/api/v1/auth/telegram/verify",
        "/api/v1/auth/telegram/widget",
        "/api/v1/auth/token/refresh",
        "/api/v1/auth/logout",
        "/api/v1/me",
        "/api/v1/me/devices",
        "/api/v1/telegram/webhook",
    } <= paths
    verify = schema["paths"]["/api/v1/auth/telegram/verify"]["post"]["responses"]
    assert {"200", "400", "403", "409", "410", "429"} <= set(verify)
    for op in ("start", "status"):
        method = "get" if op == "status" else "post"
        assert "400" in schema["paths"][f"/api/v1/auth/telegram/{op}"][method]["responses"]


def test_logout_removes_the_given_device_token_only(user):
    Device.objects.create(user=user, platform="ios", expo_push_token=TOKEN_A)
    Device.objects.create(user=user, platform="ios", expo_push_token=TOKEN_B)
    refresh = str(RefreshToken.for_user(user))
    response = auth_client(user).post(
        f"{API}/auth/logout", {"refresh": refresh, "expo_push_token": TOKEN_A}, format="json"
    )
    assert response.status_code == 204
    assert list(Device.objects.values_list("expo_push_token", flat=True)) == [TOKEN_B]


def test_logout_without_token_keeps_devices(user):
    Device.objects.create(user=user, platform="ios", expo_push_token=TOKEN_A)
    refresh = str(RefreshToken.for_user(user))
    auth_client(user).post(f"{API}/auth/logout", {"refresh": refresh}, format="json")
    assert Device.objects.count() == 1


def test_logout_with_invalid_refresh_keeps_devices(user):
    Device.objects.create(user=user, platform="ios", expo_push_token=TOKEN_A)
    auth_client(user).post(
        f"{API}/auth/logout", {"refresh": "junk", "expo_push_token": TOKEN_A}, format="json"
    )
    assert Device.objects.count() == 1


def test_api_error_keeps_message_and_code():
    from apps.core.exceptions import ApiError, InvalidTransition

    err = ApiError("boom", code="custom")
    assert err.detail["detail"] == "boom" and err.detail["code"] == "custom"
    assert err.get_codes() == {"detail": "custom", "code": "custom"}
    assert InvalidTransition("nope").detail["detail"] == "nope"


# ---- create_superadmin -------------------------------------------------------------------------


def test_create_superadmin_with_env_password(monkeypatch):
    monkeypatch.setenv("HABI_SUPERADMIN_PASSWORD", "correct-horse-battery")
    out = io.StringIO()
    call_command("create_superadmin", "--telegram-id", "424242", "--first-name", "Root", stdout=out)
    admin = User.objects.get(telegram_id=424242)
    assert admin.role == "ADMIN" and admin.is_superuser
    assert admin.check_password("correct-horse-battery")
    assert "correct-horse-battery" not in out.getvalue()


def test_create_superadmin_rejects_short_password(monkeypatch):
    monkeypatch.setenv("HABI_SUPERADMIN_PASSWORD", "short")
    with pytest.raises(CommandError):
        call_command("create_superadmin", "--telegram-id", "1")
    assert not User.objects.exists()


def test_create_superadmin_refuses_existing_telegram_id(monkeypatch):
    monkeypatch.setenv("HABI_SUPERADMIN_PASSWORD", "correct-horse-battery")
    User.objects.create_user(telegram_id=7)
    with pytest.raises(CommandError):
        call_command("create_superadmin", "--telegram-id", "7")


def test_create_superadmin_prompts_when_no_env(monkeypatch):
    monkeypatch.delenv("HABI_SUPERADMIN_PASSWORD", raising=False)
    monkeypatch.setattr("getpass.getpass", lambda prompt="": "prompted-secret-pass")
    call_command("create_superadmin", "--telegram-id", "88")
    assert User.objects.get(telegram_id=88).check_password("prompted-secret-pass")


def test_create_superadmin_prompt_mismatch(monkeypatch):
    monkeypatch.delenv("HABI_SUPERADMIN_PASSWORD", raising=False)
    answers = iter(["first-long-password", "second-long-password"])
    monkeypatch.setattr("getpass.getpass", lambda prompt="": next(answers))
    with pytest.raises(CommandError):
        call_command("create_superadmin", "--telegram-id", "89")


def test_create_superadmin_normalizes_phone(monkeypatch):
    monkeypatch.setenv("HABI_SUPERADMIN_PASSWORD", "correct-horse-battery")
    call_command("create_superadmin", "--telegram-id", "5", "--phone", "998 90 123-45-67")
    assert User.objects.get(telegram_id=5).phone == "+998901234567"


def test_create_superadmin_rejects_invalid_phone(monkeypatch):
    monkeypatch.setenv("HABI_SUPERADMIN_PASSWORD", "correct-horse-battery")
    with pytest.raises(CommandError):
        call_command("create_superadmin", "--telegram-id", "6", "--phone", "abc")


def test_create_superadmin_rejects_numeric_password(monkeypatch):
    monkeypatch.setenv("HABI_SUPERADMIN_PASSWORD", "123456789012")
    with pytest.raises(CommandError):
        call_command("create_superadmin", "--telegram-id", "7")


def test_refresh_for_deleted_user_is_401_user_not_found(user):
    refresh = str(RefreshToken.for_user(user))
    user.delete()
    response = APIClient().post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
    assert response.status_code == 401
    assert response.json()["code"] == "user_not_found"
    assert response.json()["detail"]


def test_refresh_for_inactive_user_stays_401(user):
    refresh = str(RefreshToken.for_user(user))
    User.objects.filter(pk=user.pk).update(is_active=False)
    response = APIClient().post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json")
    assert response.status_code == 401
    assert response.json().get("code") != "user_not_found"


def test_regular_refresh_response_shape_unchanged(user):
    refresh = str(RefreshToken.for_user(user))
    body = APIClient().post(f"{API}/auth/token/refresh", {"refresh": refresh}, format="json").json()
    assert set(body) == {"access", "refresh"}


def test_global_handler_still_maps_missing_rows_to_404():
    from apps.core.exception_handler import api_exception_handler

    response = api_exception_handler(User.DoesNotExist(), {})
    assert response.status_code == 404


def test_logout_never_deletes_another_users_device(user):
    other = User.objects.create_user(telegram_id=2003)
    Device.objects.create(user=other, platform="ios", expo_push_token=TOKEN_A)
    refresh = str(RefreshToken.for_user(user))
    response = auth_client(user).post(
        f"{API}/auth/logout", {"refresh": refresh, "expo_push_token": TOKEN_A}, format="json"
    )
    assert response.status_code == 204  # the same answer as for an unknown token: nothing leaks
    assert Device.objects.get(expo_push_token=TOKEN_A).user == other


def test_delete_device_never_removes_another_users_token(user):
    other = User.objects.create_user(telegram_id=2004)
    Device.objects.create(user=other, platform="ios", expo_push_token=TOKEN_A)
    response = auth_client(user).delete(
        f"{API}/me/devices", {"expo_push_token": TOKEN_A}, format="json"
    )
    assert response.status_code == 204
    assert Device.objects.filter(user=other, expo_push_token=TOKEN_A).exists()
