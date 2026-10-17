import pytest

from apps.telegram_bot import login_service as svc
from apps.telegram_bot.handlers import handle_update

pytestmark = pytest.mark.django_db

USER_ID = 777001


def msg(text=None, contact=None, user_id=USER_ID, chat_type="private", lang="uz", update_id=1):
    message = {
        "message_id": 1,
        "from": {"id": user_id, "is_bot": False, "first_name": "Ali", "language_code": lang},
        "chat": {"id": user_id, "type": chat_type},
    }
    if text is not None:
        message["text"] = text
    if contact is not None:
        message["contact"] = contact
    return {"update_id": update_id, "message": message}


def own_contact(phone="998901234567", user_id=USER_ID):
    return {"phone_number": phone, "first_name": "Ali", "last_name": "V", "user_id": user_id}


def has_contact_button(markup):
    buttons = [b for row in (markup or {}).get("keyboard", []) for b in row]
    return any(b.get("request_contact") is True for b in buttons)


def has_cyrillic(text):
    return any("Ѐ" <= ch <= "ӿ" for ch in text)


def extract_code(text):
    words = [w.strip(".:()*`") for w in text.split()]
    return next(w for w in words if w.isdigit() and len(w) == 6)


def test_start_without_parameter_explains_app_flow_and_binds_nothing(tg_client):
    handle_update(msg("/start"), tg_client)
    assert len(tg_client.sent) == 1
    assert not has_contact_button(tg_client.last["reply_markup"])
    assert svc.token_for_chat(USER_ID) is None


def test_start_with_valid_token_requests_contact_and_binds_chat(tg_client):
    token = svc.start_login().token
    handle_update(msg(f"/start {token}"), tg_client)
    assert has_contact_button(tg_client.last["reply_markup"])
    assert svc.token_for_chat(USER_ID) == token


@pytest.mark.parametrize("bad", ["x" * 30, "evil'; DROP TABLE--", "a" * 100, "tglogin:1"])
def test_start_with_unknown_or_malformed_token_does_not_bind(tg_client, bad):
    handle_update(msg(f"/start {bad}"), tg_client)
    assert svc.token_for_chat(USER_ID) is None
    assert not has_contact_button(tg_client.last["reply_markup"])


def test_own_contact_confirms_and_sends_code(tg_client):
    token = svc.start_login().token
    handle_update(msg(f"/start {token}"), tg_client)
    handle_update(msg(contact=own_contact()), tg_client)
    assert svc.get_status(token) == "CONFIRMED"
    identity = svc.verify_code(token, extract_code(tg_client.last["text"]))
    assert identity.telegram_id == USER_ID
    assert identity.phone == "+998901234567"
    assert identity.first_name == "Ali"


def test_foreign_contact_is_rejected(tg_client):
    token = svc.start_login().token
    handle_update(msg(f"/start {token}"), tg_client)
    handle_update(msg(contact=own_contact(user_id=999999)), tg_client)
    assert svc.get_status(token) == "PENDING"
    with pytest.raises(StopIteration):
        extract_code(tg_client.last["text"])
    assert has_contact_button(tg_client.last["reply_markup"])


def test_contact_without_user_id_is_rejected(tg_client):
    token = svc.start_login().token
    handle_update(msg(f"/start {token}"), tg_client)
    handle_update(msg(contact={"phone_number": "998901234567", "first_name": "X"}), tg_client)
    assert svc.get_status(token) == "PENDING"


def test_contact_without_prior_start_does_nothing_harmful(tg_client):
    handle_update(msg(contact=own_contact()), tg_client)
    assert len(tg_client.sent) == 1
    assert not has_contact_button(tg_client.last["reply_markup"])


def test_invalid_phone_rejected(tg_client):
    token = svc.start_login().token
    handle_update(msg(f"/start {token}"), tg_client)
    handle_update(msg(contact=own_contact(phone="not-a-phone")), tg_client)
    assert svc.get_status(token) == "PENDING"


def test_contact_cannot_confirm_a_token_bound_by_another_chat(tg_client):
    token = svc.start_login().token
    handle_update(msg(f"/start {token}", user_id=111), tg_client)
    handle_update(msg(contact=own_contact(user_id=222), user_id=222), tg_client)
    assert svc.get_status(token) == "PENDING"


def test_binding_consumed_after_confirmation(tg_client):
    token = svc.start_login().token
    handle_update(msg(f"/start {token}"), tg_client)
    handle_update(msg(contact=own_contact()), tg_client)
    assert svc.token_for_chat(USER_ID) is None
    handle_update(msg(contact=own_contact()), tg_client)
    assert svc.get_status(token) == "CONFIRMED"


def test_group_chat_messages_are_ignored(tg_client):
    handle_update(msg("/start", chat_type="group"), tg_client)
    assert tg_client.sent == []


@pytest.mark.parametrize("update", [{"update_id": 1}, {"update_id": 2, "edited_message": {}}])
def test_updates_without_message_are_ignored(tg_client, update):
    handle_update(update, tg_client)
    assert tg_client.sent == []


def test_russian_user_gets_russian_text(tg_client):
    handle_update(msg("/start", lang="ru"), tg_client)
    assert has_cyrillic(tg_client.last["text"])


def test_unknown_language_falls_back_to_uzbek(tg_client):
    handle_update(msg("/start", lang="de"), tg_client)
    german = tg_client.last["text"]
    handle_update(msg("/start", lang="uz"), tg_client)
    assert tg_client.last["text"] == german


def test_existing_user_language_wins(tg_client):
    from apps.accounts.models import User

    User.objects.create_user(telegram_id=USER_ID, language="ru")
    handle_update(msg("/start", lang="en"), tg_client)
    assert has_cyrillic(tg_client.last["text"])


def test_plain_text_gets_help_reply(tg_client):
    handle_update(msg("hello"), tg_client)
    assert len(tg_client.sent) == 1


def test_phone_never_logged(tg_client, caplog):
    caplog.set_level("DEBUG")
    token = svc.start_login().token
    handle_update(msg(f"/start {token}"), tg_client)
    handle_update(msg(contact=own_contact()), tg_client)
    assert "998901234567" not in caplog.text
