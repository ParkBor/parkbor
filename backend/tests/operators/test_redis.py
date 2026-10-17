"""Behaviour on a REAL Redis (CI service; skipped locally without REDIS_TEST_URL).

fakeredis cannot prove key expiry, ``INCR`` semantics or the Django Redis cache backend, and the
QR "spent" fast path plus the scan / invitation counters depend on exactly those.
"""

import os
from datetime import timedelta

import pytest
import redis as redis_lib
from django.core.cache import cache, caches

from apps.bookings import qr
from apps.core import attempts, redis_client
from apps.operators import scan_guard
from apps.operators import services as operator_services
from apps.parking.models import LotStatus
from tests.helpers import make_lot, make_user
from tests.operators.helpers import book, entry_token, make_gate

pytestmark = [pytest.mark.redis, pytest.mark.django_db]


@pytest.fixture
def real_redis(fake_redis, settings):
    """A real client for ``get_redis()`` and a Redis-backed Django cache, flushed around the test."""
    url = os.environ["REDIS_TEST_URL"]
    client = redis_lib.Redis.from_url(url, decode_responses=True)
    client.flushdb()
    redis_client.set_redis_client(client)
    settings.CACHES = {
        "default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": url}
    }
    caches["default"].clear()
    yield client
    client.flushdb()
    redis_client.set_redis_client(fake_redis)


def test_the_spent_marker_is_written_after_commit_with_a_ttl(
    real_redis, django_capture_on_commit_callbacks
):
    from apps.bookings import checkin

    gate = make_gate()
    booking = book(gate)
    claims = qr.verify_token(entry_token(booking), now=gate.now)
    key = f"habi:qr:used:{claims.booking_id}:{claims.nonce}"

    with django_capture_on_commit_callbacks(execute=True):
        checkin.check_in(operator=gate.operator, token=entry_token(booking), now=gate.now)

    assert real_redis.get(key) == "1"
    assert 0 < real_redis.ttl(key) <= int(timedelta(hours=4).total_seconds())


def test_the_fast_path_answers_spent_even_if_the_database_flag_were_lost(real_redis):
    gate = make_gate()
    booking = book(gate)
    claims = qr.verify_token(entry_token(booking), now=gate.now)
    real_redis.set(f"habi:qr:used:{claims.booking_id}:{claims.nonce}", "1", ex=60)

    assert qr.consume_nonce(claims, now=gate.now) is False


def test_the_nonce_is_still_one_time_when_redis_is_flushed(real_redis):
    gate = make_gate()
    booking = book(gate)
    claims = qr.verify_token(entry_token(booking), now=gate.now)
    assert qr.consume_nonce(claims, now=gate.now) is True
    real_redis.flushdb()  # Redis lost everything: the database column still holds the truth

    assert qr.consume_nonce(claims, now=gate.now) is False


def test_scan_counter_keys_expire_and_incr_keeps_the_ttl(real_redis, settings):
    settings.OPERATOR_SCAN_FAIL_WINDOW_SECONDS = 120
    gate = make_gate()
    for _ in range(3):
        scan_guard.record_failure(gate.operator, "qr_invalid", gate.lot.id)

    keys = real_redis.keys("*scanfail*")

    assert len(keys) == 2  # the count and its end marker
    for key in keys:
        assert 0 < real_redis.ttl(key) <= 120  # never persistent, however often it was bumped


def test_the_scan_lock_engages_and_a_ttl_less_orphan_never_locks(real_redis, settings):
    settings.OPERATOR_SCAN_FAIL_LIMIT = 3
    gate = make_gate()
    for _ in range(3):
        scan_guard.record_failure(gate.operator, "qr_invalid", gate.lot.id)
    with pytest.raises(Exception, match="scan_locked|Too many"):
        scan_guard.assert_open(gate.operator, gate.lot.id)

    # an orphaned count (end marker gone, e.g. INCR re-created an expired key) is open
    for key in real_redis.keys("*scanfail:until*"):
        real_redis.delete(key)
    scan_guard.assert_open(gate.operator, gate.lot.id)


def test_a_counter_key_that_expires_mid_window_starts_a_fresh_window(real_redis):
    counter = attempts.FailureCounter("probe", 3, 60)
    counter.record("k")
    for key in real_redis.keys("*probe:n:k*"):
        real_redis.delete(key)

    assert counter.record("k") == 1
    assert all(real_redis.ttl(key) > 0 for key in real_redis.keys("*probe*"))


def test_wrong_invitation_codes_lock_the_account_on_real_redis(real_redis, settings):
    settings.OPERATOR_INVITE_FAIL_LIMIT = 2
    owner = make_user("OWNER")
    lot = make_lot(owner, "Real", status=LotStatus.ACTIVE)
    good = operator_services.create_invite(lot=lot, actor=owner)[1]
    person = make_user("DRIVER")
    for _ in range(2):
        with pytest.raises(operator_services.InviteInvalid):
            operator_services.accept_invite(user=person, code="ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z")

    with pytest.raises(operator_services.InviteLocked):
        operator_services.accept_invite(user=person, code=good)
    assert cache.get("nothing") is None
