import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from freezegun import freeze_time

from apps.telegram_bot import login_service as svc
from apps.telegram_bot.login_service import TelegramIdentity

IDENTITY = TelegramIdentity(
    telegram_id=777001, phone="+998901234567", username="ali", first_name="Ali", last_name="V"
)


def _confirmed(device_id="dev-1"):
    started = svc.start_login(device_id)
    assert svc.bind_chat(started.token, IDENTITY.telegram_id)
    code = svc.confirm_contact(started.token, IDENTITY)
    return started.token, code


def test_start_login_creates_urlsafe_token_with_5_minute_ttl(fake_redis):
    started = svc.start_login("dev-1")
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", started.token)
    assert started.expires_in == 300
    assert 0 < fake_redis.ttl(f"tglogin:{started.token}") <= 300


def test_tokens_are_unique():
    assert len({svc.start_login().token for _ in range(50)}) == 50


def test_new_login_is_pending():
    assert svc.get_status(svc.start_login().token) == "PENDING"


def test_unknown_token_is_expired():
    assert svc.get_status("nope-" + "x" * 30) == "EXPIRED"


def test_confirm_returns_six_digit_code_and_status_confirmed():
    token, code = _confirmed()
    assert re.fullmatch(r"\d{6}", code)
    assert svc.get_status(token) == "CONFIRMED"


def test_code_is_stored_hashed_only(fake_redis):
    token, code = _confirmed()
    stored = fake_redis.hgetall(f"tglogin:{token}")
    assert code not in stored.values()
    assert code not in str(stored)
    assert stored["code_hash"]


def test_confirm_keeps_original_expiry(fake_redis):
    started = svc.start_login()
    fake_redis.expire(f"tglogin:{started.token}", 100)
    svc.bind_chat(started.token, 1)
    svc.confirm_contact(started.token, IDENTITY)
    assert 0 < fake_redis.ttl(f"tglogin:{started.token}") <= 100


def test_confirm_unknown_token_returns_none():
    assert svc.confirm_contact("unknown-token-" + "x" * 20, IDENTITY) is None


def test_confirm_twice_is_refused():
    token, _ = _confirmed()
    assert svc.confirm_contact(token, IDENTITY) is None


def test_bind_chat_unknown_token_false():
    assert svc.bind_chat("unknown-token-" + "x" * 20, 5) is False


def test_chat_binding_roundtrip():
    started = svc.start_login()
    svc.bind_chat(started.token, 42)
    assert svc.token_for_chat(42) == started.token
    assert svc.token_for_chat(43) is None


def test_verify_returns_identity_and_is_single_use():
    token, code = _confirmed()
    assert svc.verify_code(token, code) == IDENTITY
    with pytest.raises(svc.LoginExpiredError):
        svc.verify_code(token, code)


def test_verify_before_confirmation_raises_not_confirmed():
    started = svc.start_login()
    with pytest.raises(svc.LoginNotConfirmedError):
        svc.verify_code(started.token, "123456")


def test_wrong_code_raises_invalid_and_keeps_token():
    token, code = _confirmed()
    wrong = "000000" if code != "000000" else "111111"
    with pytest.raises(svc.InvalidCodeError):
        svc.verify_code(token, wrong)
    assert svc.verify_code(token, code) == IDENTITY


def test_five_wrong_codes_cancel_the_token_even_for_correct_code():
    token, code = _confirmed()
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(svc.MAX_ATTEMPTS):
        with pytest.raises(svc.InvalidCodeError):
            svc.verify_code(token, wrong)
    assert svc.get_status(token) == "EXPIRED"
    with pytest.raises(svc.LoginExpiredError):
        svc.verify_code(token, code)


def test_four_wrong_then_correct_still_succeeds():
    token, code = _confirmed()
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(svc.MAX_ATTEMPTS - 1):
        with pytest.raises(svc.InvalidCodeError):
            svc.verify_code(token, wrong)
    assert svc.verify_code(token, code) == IDENTITY


def test_expired_token_cannot_verify():
    with freeze_time("2026-01-01 10:00:00") as clock:
        token, code = _confirmed()
        clock.tick(timedelta(seconds=svc.LOGIN_TTL_SECONDS - 1))
        assert svc.get_status(token) == "CONFIRMED"
        clock.tick(timedelta(seconds=2))
        assert svc.get_status(token) == "EXPIRED"
        with pytest.raises(svc.LoginExpiredError):
            svc.verify_code(token, code)


def test_pending_session_expires_after_five_minutes():
    with freeze_time("2026-01-01 10:00:00") as clock:
        token = svc.start_login().token
        clock.tick(timedelta(minutes=5, seconds=1))
        assert svc.get_status(token) == "EXPIRED"
        assert svc.bind_chat(token, 1) is False
        assert svc.confirm_contact(token, IDENTITY) is None


def test_code_of_another_token_is_rejected():
    token_a, code_a = _confirmed()
    other = svc.start_login()
    svc.bind_chat(other.token, 9)
    svc.confirm_contact(other.token, IDENTITY)
    other_code = svc.confirm_contact(other.token, IDENTITY)
    with pytest.raises(svc.InvalidCodeError):
        svc.verify_code(other.token, "000000" if other_code != "000000" else "111111")
    assert svc.get_status(token_a) == "CONFIRMED"


def test_malformed_token_is_treated_as_expired(fake_redis):
    assert svc.get_status("bad token with spaces") == "EXPIRED"
    assert svc.bind_chat("tglogin:../x", 1) is False


# ---- atomicity ---------------------------------------------------------------------------------


def test_confirm_on_vanished_session_does_not_resurrect_it(fake_redis):
    started = svc.start_login()
    svc.bind_chat(started.token, IDENTITY.telegram_id)
    fake_redis.delete(f"tglogin:{started.token}")
    assert svc.confirm_contact(started.token, IDENTITY) is None
    assert not fake_redis.exists(f"tglogin:{started.token}")


def test_bind_on_vanished_session_creates_no_binding(fake_redis):
    started = svc.start_login()
    fake_redis.delete(f"tglogin:{started.token}")
    assert svc.bind_chat(started.token, 5) is False
    assert svc.token_for_chat(5) is None


def test_confirmed_session_always_has_ttl(fake_redis):
    token, _ = _confirmed()
    assert 0 < fake_redis.ttl(f"tglogin:{token}") <= svc.LOGIN_TTL_SECONDS


def test_concurrent_confirms_issue_exactly_one_code():
    started = svc.start_login()
    svc.bind_chat(started.token, IDENTITY.telegram_id)
    barrier = threading.Barrier(16)

    def attempt(_):
        barrier.wait()
        return svc.confirm_contact(started.token, IDENTITY)

    with ThreadPoolExecutor(16) as pool:
        results = list(pool.map(attempt, range(16)))
    codes = [r for r in results if r]
    assert len(codes) == 1
    assert svc.verify_code(started.token, codes[0]) == IDENTITY


def test_concurrent_correct_verifies_succeed_once():
    token, code = _confirmed()
    barrier = threading.Barrier(16)

    def attempt(_):
        barrier.wait()
        try:
            return svc.verify_code(token, code)
        except svc.LoginExpiredError:
            return None

    with ThreadPoolExecutor(16) as pool:
        results = list(pool.map(attempt, range(16)))
    assert sum(1 for r in results if r is not None) == 1


def test_concurrent_wrong_codes_cannot_exceed_attempt_limit():
    token, code = _confirmed()
    wrong = "000000" if code != "000000" else "111111"
    barrier = threading.Barrier(16)
    outcomes = []

    def attempt(_):
        barrier.wait()
        try:
            svc.verify_code(token, wrong)
        except svc.InvalidCodeError:
            outcomes.append("invalid")
        except svc.LoginExpiredError:
            outcomes.append("expired")

    with ThreadPoolExecutor(16) as pool:
        list(pool.map(attempt, range(16)))
    assert outcomes.count("invalid") == svc.MAX_ATTEMPTS
    assert svc.get_status(token) == "EXPIRED"


def test_cancel_login_removes_session():
    token, _ = _confirmed()
    svc.cancel_login(token)
    assert svc.get_status(token) == "EXPIRED"
    svc.cancel_login("not-a-token")  # no-op, no error
