import json

import pytest
from rest_framework.test import APIClient

from apps.telegram_bot import login_service as svc
from tests.auth_fixtures import WEBHOOK_SECRET

pytestmark = pytest.mark.django_db
URL = "/api/v1/telegram/webhook"
HEADER = "HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN"


def post(update, secret=WEBHOOK_SECRET, **extra):
    headers = {HEADER: secret} if secret is not None else {}
    return APIClient().post(
        URL, data=json.dumps(update), content_type="application/json", **headers, **extra
    )


def start_update(text="/start", user_id=777001):
    return {
        "update_id": 10,
        "message": {
            "message_id": 1,
            "from": {"id": user_id, "is_bot": False, "first_name": "Ali"},
            "chat": {"id": user_id, "type": "private"},
            "text": text,
        },
    }


def test_missing_secret_header_forbidden(tg_client):
    assert post(start_update(), secret=None).status_code == 403
    assert tg_client.sent == []


@pytest.mark.parametrize("secret", ["wrong", "", WEBHOOK_SECRET + "x", WEBHOOK_SECRET[:-1]])
def test_wrong_secret_forbidden(tg_client, secret):
    assert post(start_update(), secret=secret).status_code == 403
    assert tg_client.sent == []


def test_unconfigured_secret_fails_closed(tg_client, settings):
    settings.TELEGRAM_WEBHOOK_SECRET = ""
    assert post(start_update(), secret="").status_code == 403


def test_valid_secret_processes_update(tg_client):
    token = svc.start_login().token
    response = post(start_update(f"/start {token}"))
    assert response.status_code == 200
    assert svc.token_for_chat(777001) == token
    assert len(tg_client.sent) == 1


def test_no_authentication_required_even_with_bad_bearer(tg_client):
    assert post(start_update(), HTTP_AUTHORIZATION="Bearer garbage").status_code == 200


def test_malformed_body_is_400(tg_client):
    assert post({"nothing": 1}).status_code == 400


def test_handler_crash_still_returns_200(monkeypatch, tg_client):
    from apps.telegram_bot import handlers

    def boom(update, client):
        raise RuntimeError("boom")

    monkeypatch.setattr(handlers, "handle_update", boom)
    assert post(start_update()).status_code == 200


def test_get_not_allowed():
    assert APIClient().get(URL, **{HEADER: WEBHOOK_SECRET}).status_code == 405
