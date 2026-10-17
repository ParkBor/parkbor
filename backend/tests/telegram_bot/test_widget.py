import hashlib
import hmac
import time

from apps.telegram_bot.widget import MAX_AUTH_AGE_SECONDS, verify_telegram_widget

BOT_TOKEN = "123456:TEST-TOKEN"


def sign(data, bot_token=BOT_TOKEN):
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hashlib.sha256(bot_token.encode()).digest()
    return {**data, "hash": hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()}


def payload(**overrides):
    base = {"id": 777001, "first_name": "Ali", "username": "ali", "auth_date": int(time.time())}
    return sign({**base, **overrides})


def test_valid_signature_accepted():
    assert verify_telegram_widget(payload(), BOT_TOKEN) is True


def test_does_not_mutate_input():
    data = payload()
    snapshot = dict(data)
    verify_telegram_widget(data, BOT_TOKEN)
    assert data == snapshot


def test_tampered_field_rejected():
    data = payload()
    data["id"] = 1
    assert verify_telegram_widget(data, BOT_TOKEN) is False


def test_wrong_bot_token_rejected():
    assert verify_telegram_widget(payload(), "999:OTHER") is False


def test_missing_hash_rejected():
    data = payload()
    del data["hash"]
    assert verify_telegram_widget(data, BOT_TOKEN) is False


def test_missing_auth_date_rejected():
    data = sign({"id": 1, "first_name": "A"})
    assert verify_telegram_widget(data, BOT_TOKEN) is False


def test_non_numeric_auth_date_rejected():
    assert verify_telegram_widget(sign({"id": 1, "auth_date": "abc"}), BOT_TOKEN) is False


def test_old_auth_date_rejected():
    old = int(time.time()) - MAX_AUTH_AGE_SECONDS - 5
    assert verify_telegram_widget(payload(auth_date=old), BOT_TOKEN) is False


def test_auth_date_just_inside_window_accepted():
    ok = int(time.time()) - MAX_AUTH_AGE_SECONDS + 30
    assert verify_telegram_widget(payload(auth_date=ok), BOT_TOKEN) is True


def test_future_auth_date_rejected():
    assert verify_telegram_widget(payload(auth_date=int(time.time()) + 3600), BOT_TOKEN) is False


def test_empty_bot_token_rejected():
    assert verify_telegram_widget(payload(), "") is False


def test_now_parameter_controls_freshness():
    data = payload(auth_date=1_000_000)
    assert verify_telegram_widget(data, BOT_TOKEN, now=1_000_100) is True
    assert (
        verify_telegram_widget(data, BOT_TOKEN, now=1_000_000 + MAX_AUTH_AGE_SECONDS + 1) is False
    )


def test_non_ascii_hash_is_rejected_without_error():
    data = payload()
    data["hash"] = "é" * 64
    assert verify_telegram_widget(data, BOT_TOKEN) is False


def test_future_auth_date_beyond_skew_rejected_and_within_skew_accepted():
    assert verify_telegram_widget(payload(auth_date=int(time.time()) + 120), BOT_TOKEN) is False
    assert verify_telegram_widget(payload(auth_date=int(time.time()) + 30), BOT_TOKEN) is True
