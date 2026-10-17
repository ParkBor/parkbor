"""Review-driven hardening: widget replay, logging, schema exposure, outages, delivery failures."""

import hashlib
import hmac
import importlib
import logging
import time

import pytest
import redis as redis_lib
from rest_framework.test import APIClient

from apps.accounts.models import Device, User
from apps.core import redis_client
from apps.telegram_bot import login_service as svc
from apps.telegram_bot.handlers import handle_update
from apps.telegram_bot.login_service import TelegramIdentity
from tests.auth_fixtures import BOT_TOKEN

pytestmark = pytest.mark.django_db
BASE = "/api/v1/auth/telegram"


def sign(data):
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hashlib.sha256(BOT_TOKEN.encode()).digest()
    return {**data, "hash": hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()}


def widget_payload(**extra):
    return sign({"id": 777001, "auth_date": int(time.time()), **extra})


# ---- widget replay / raw HMAC ------------------------------------------------------------------


def test_widget_payload_cannot_be_replayed():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    data = widget_payload(first_name="Ali")
    assert APIClient().post(f"{BASE}/widget", data, format="json").status_code == 200
    again = APIClient().post(f"{BASE}/widget", data, format="json")
    assert again.status_code == 400
    assert again.json()["code"] == "invalid_widget"


def test_widget_failed_role_check_does_not_block_other_payloads():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    assert (
        APIClient()
        .post(f"{BASE}/widget", widget_payload(first_name="A"), format="json")
        .status_code
        == 200
    )
    assert (
        APIClient()
        .post(f"{BASE}/widget", widget_payload(first_name="B"), format="json")
        .status_code
        == 200
    )


def test_widget_name_with_surrounding_spaces_verifies_against_raw_value():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    data = widget_payload(first_name="  Ali  ")
    assert APIClient().post(f"{BASE}/widget", data, format="json").status_code == 200


def test_widget_unknown_extra_field_is_part_of_the_signature():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    data = widget_payload(some_new_field="x")
    assert APIClient().post(f"{BASE}/widget", data, format="json").status_code == 200
    forged = widget_payload()
    forged["some_new_field"] = "x"  # added after signing
    assert APIClient().post(f"{BASE}/widget", forged, format="json").status_code == 400


def test_widget_nested_values_rejected():
    data = widget_payload()
    data["first_name"] = {"a": 1}
    assert APIClient().post(f"{BASE}/widget", data, format="json").status_code == 400


def test_widget_max_age_is_five_minutes():
    from apps.telegram_bot.widget import MAX_AUTH_AGE_SECONDS

    assert MAX_AUTH_AGE_SECONDS == 300


def test_widget_six_minute_old_payload_rejected():
    User.objects.create_user(telegram_id=777001, role=User.Role.ADMIN)
    data = sign({"id": 777001, "auth_date": int(time.time()) - 360})
    assert APIClient().post(f"{BASE}/widget", data, format="json").status_code == 400


# ---- logging -----------------------------------------------------------------------------------


def test_http_client_loggers_do_not_emit_info():
    for name in ("httpx", "httpcore"):
        assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING


def test_app_audit_loggers_stay_visible():
    assert logging.getLogger("apps.telegram_bot.login_service").getEffectiveLevel() <= logging.INFO


# ---- Redis outage -> 503 -----------------------------------------------------------------------


class BrokenRedis:
    def __getattr__(self, name):
        def fail(*args, **kwargs):
            raise redis_lib.exceptions.ConnectionError("down")

        return fail


def test_redis_outage_returns_503_with_code():
    redis_client.set_redis_client(BrokenRedis())
    response = APIClient().post(f"{BASE}/start", {}, format="json")
    assert response.status_code == 503
    assert response.json()["code"] == "service_unavailable"
    assert "down" not in response.content.decode()


def test_real_redis_client_has_socket_timeouts(settings):
    redis_client.set_redis_client(None)
    settings.REDIS_URL = "redis://localhost:6399/0"
    kwargs = redis_client.get_redis().connection_pool.connection_kwargs
    assert kwargs["socket_timeout"] and kwargs["socket_connect_timeout"]
    redis_client.set_redis_client(None)


# ---- delivery failure --------------------------------------------------------------------------


class FailingClient:
    def __init__(self, fail_on_code=True):
        self.sent = []
        self.fail_on_code = fail_on_code

    def send_message(self, chat_id, text, reply_markup=None):
        if self.fail_on_code and any(w.isdigit() and len(w) == 6 for w in text.split()):
            raise RuntimeError("telegram down")
        self.sent.append(text)


def _update(text=None, contact=None):
    message = {
        "from": {"id": 5, "first_name": "A", "language_code": "en"},
        "chat": {"id": 5, "type": "private"},
    }
    if text:
        message["text"] = text
    if contact:
        message["contact"] = contact
    return {"update_id": 1, "message": message}


def test_session_cancelled_when_code_cannot_be_delivered():
    client = FailingClient()
    token = svc.start_login().token
    handle_update(_update(f"/start {token}"), client)
    handle_update(_update(contact={"phone_number": "998901234567", "user_id": 5}), client)
    assert svc.get_status(token) == "EXPIRED"
    assert client.sent  # the user was told to retry


# ---- accounts races ----------------------------------------------------------------------------


def test_relogin_save_integrity_error_becomes_phone_taken(monkeypatch):
    from django.db import IntegrityError

    from apps.accounts import services
    from apps.core.exceptions import PhoneTakenError

    User.objects.create_user(telegram_id=1, phone="+998901111111")
    monkeypatch.setattr(
        User, "save", lambda self, *a, **k: (_ for _ in ()).throw(IntegrityError("dup"))
    )
    with pytest.raises(PhoneTakenError):
        services.login_with_telegram(
            telegram_id=1, phone="+998902222222", username="", first_name="", last_name=""
        )


def test_register_device_retries_after_concurrent_insert(monkeypatch):
    from django.db import IntegrityError

    from apps.accounts import services

    user = User.objects.create_user(telegram_id=1)
    real = Device.objects.update_or_create
    calls = []

    def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            real(*args, **kwargs)  # the "other request" wins the insert
            raise IntegrityError("dup")
        return real(*args, **kwargs)

    monkeypatch.setattr(Device.objects, "update_or_create", flaky)
    device, _ = services.register_device(
        user, platform="ios", expo_push_token="ExponentPushToken[abcdefgh]"
    )
    assert device.user == user and Device.objects.count() == 1


# ---- schema exposure / hashers / messages ------------------------------------------------------


def test_schema_and_docs_routes_absent_when_not_public(settings):
    settings.SCHEMA_PUBLIC = False
    import config.urls as urls

    reloaded = importlib.reload(urls)
    try:
        names = {getattr(p, "name", None) for p in reloaded.urlpatterns}
        assert "schema" not in names and "docs" not in names
    finally:
        settings.SCHEMA_PUBLIC = True
        importlib.reload(urls)


def test_prod_hashers_start_with_argon2(monkeypatch):
    from tests.test_settings import PROD_ENV, _import_fresh

    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert prod.PASSWORD_HASHERS[0].endswith("Argon2PasswordHasher")
    assert prod.SCHEMA_PUBLIC is False


@pytest.mark.parametrize("lang", ["uz", "ru", "en"])
def test_code_message_warns_not_to_share_and_start_names_app_context(lang):
    from apps.telegram_bot import messages

    warn = {"uz": "hech kimga", "ru": "никому", "en": "anyone"}[lang]
    assert warn in messages.text(lang, "code_sent", code="123456").lower()
    assert "Habi" in messages.text(lang, "ask_contact")


# ---- throttles ---------------------------------------------------------------------------------


def test_status_polling_has_higher_limit_than_login_start():
    client = APIClient()
    codes = [client.get(f"{BASE}/status", {"login_token": "u" * 43}).status_code for _ in range(30)]
    assert 429 not in codes


def test_refresh_endpoint_is_throttled():
    client = APIClient()
    codes = [
        client.post("/api/v1/auth/token/refresh", {"refresh": "bad"}, format="json").status_code
        for _ in range(40)
    ]
    assert codes[-1] == 429


def test_status_is_still_bounded():
    client = APIClient()
    codes = [client.get(f"{BASE}/status", {"login_token": "u" * 43}).status_code for _ in range(70)]
    assert codes[-1] == 429


def test_code_must_be_ascii_digits():
    token = svc.start_login().token
    response = APIClient().post(
        f"{BASE}/verify", {"login_token": token, "code": "١٢٣٤٥٦"}, format="json"
    )
    assert response.status_code == 400


def test_non_ascii_webhook_secret_header_is_rejected_not_500():
    response = APIClient().post(
        "/api/v1/telegram/webhook",
        {"update_id": 1},
        format="json",
        HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN="sécret",
    )
    assert response.status_code == 403


def test_wrong_length_secret_with_matching_prefix_rejected():
    from tests.auth_fixtures import WEBHOOK_SECRET

    response = APIClient().post(
        "/api/v1/telegram/webhook",
        {"update_id": 1},
        format="json",
        HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN=WEBHOOK_SECRET + "0",
    )
    assert response.status_code == 403


def test_identity_dataclass_still_frozen():
    ident = TelegramIdentity(1, "+998901234567", "", "", "")
    with pytest.raises(AttributeError):
        ident.phone = "x"  # type: ignore[misc]


# ---- second review round -----------------------------------------------------------------------


@pytest.mark.parametrize("bad_hash", ["é" * 64, "A" * 64, "g" * 64, "0" * 63, "0" * 65])
def test_widget_hash_must_be_64_lowercase_hex(bad_hash):
    data = widget_payload()
    data["hash"] = bad_hash
    assert APIClient().post(f"{BASE}/widget", data, format="json").status_code == 400


def _wrap_pipeline(fake_redis, monkeypatch, fail_times):
    """Make the first `fail_times` EXEC calls raise WatchError (simulates a concurrent write)."""
    real = fake_redis.pipeline
    state = {"fails": fail_times, "attempts": 0}

    def pipeline(*args, **kwargs):
        pipe = real(*args, **kwargs)
        real_execute = pipe.execute

        def execute(*a, **k):
            state["attempts"] += 1
            if state["fails"] > 0:
                state["fails"] -= 1
                pipe.reset()
                raise redis_lib.WatchError
            return real_execute(*a, **k)

        pipe.execute = execute
        return pipe

    monkeypatch.setattr(fake_redis, "pipeline", pipeline)
    return state


def test_watch_error_is_retried_and_result_is_still_correct(fake_redis, monkeypatch):
    token = svc.start_login().token
    svc.bind_chat(token, 5)
    state = _wrap_pipeline(fake_redis, monkeypatch, fail_times=2)
    ident = TelegramIdentity(5, "+998901234567", "", "A", "")
    code = svc.confirm_contact(token, ident)
    assert code and state["attempts"] == 3
    assert svc.verify_code(token, code) == ident


def test_endless_contention_fails_closed_with_503(fake_redis, monkeypatch):
    from apps.core.exceptions import ServiceUnavailableError

    token = svc.start_login().token
    svc.bind_chat(token, 5)
    state = _wrap_pipeline(fake_redis, monkeypatch, fail_times=10_000)
    with pytest.raises(ServiceUnavailableError):
        svc.confirm_contact(token, TelegramIdentity(5, "+998901234567", "", "A", ""))
    assert state["attempts"] == svc.MAX_TXN_RETRIES
    assert svc.get_status(token) == "PENDING"  # nothing half-written


def test_endless_contention_on_verify_is_503_over_http(fake_redis, monkeypatch):
    token = svc.start_login().token
    svc.bind_chat(token, 5)
    code = svc.confirm_contact(token, TelegramIdentity(5, "+998901234567", "", "A", ""))
    _wrap_pipeline(fake_redis, monkeypatch, fail_times=10_000)
    response = APIClient().post(
        f"{BASE}/verify", {"login_token": token, "code": code}, format="json"
    )
    assert response.status_code == 503


def test_logout_refresh_has_max_length():
    user = User.objects.create_user(telegram_id=42)
    client = APIClient()
    from rest_framework_simplejwt.tokens import RefreshToken

    client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(user).access_token}")
    response = client.post("/api/v1/auth/logout", {"refresh": "x" * 5000}, format="json")
    assert response.status_code == 400


def test_authenticated_endpoints_are_throttled_per_user():
    from rest_framework_simplejwt.tokens import RefreshToken

    user = User.objects.create_user(telegram_id=43)
    other = User.objects.create_user(telegram_id=44)

    def client_for(u):
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(u).access_token}")
        return c

    mine, theirs = client_for(user), client_for(other)
    codes = [mine.get("/api/v1/me").status_code for _ in range(61)]
    assert codes[:60] == [200] * 60 and codes[60] == 429
    assert theirs.get("/api/v1/me").status_code == 200


@pytest.mark.parametrize(
    ("lang", "phrase"),
    [("uz", "o'zingiz boshlagan"), ("ru", "сами начали"), ("en", "yourself")],
)
def test_ask_contact_warns_to_continue_only_if_user_started_it(lang, phrase):
    from apps.telegram_bot import messages

    assert phrase in messages.text(lang, "ask_contact")
