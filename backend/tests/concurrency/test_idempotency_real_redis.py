"""The Idempotency-Key store on a REAL Redis (SET NX EX, TTLs, parallel duplicates).

tests/bookings/test_idempotency.py covers the logic on fakeredis; here the atomicity of the
claim and the real expiry behaviour are exercised. Skipped without REDIS_TEST_URL, mandatory in
CI (REQUIRE_REDIS=1).
"""

import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from apps.bookings import idempotency
from apps.bookings.errors import IdempotencyConflict, IdempotencyInProgress

pytestmark = pytest.mark.redis

USER = uuid.uuid4()
KEY = "real-redis-key-0001"
FP = "fingerprint-a"
RACERS = 50


def race(job, n=RACERS):
    """Run `job(i)` in n threads released together; returns [("ok", value) | ("err", exc)]."""
    barrier = threading.Barrier(n)

    def run(i):
        barrier.wait(timeout=30)
        try:
            return "ok", job(i)
        except Exception as exc:  # noqa: BLE001 - reported to the assertions
            return "err", exc

    with ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(run, range(n)))


def redis_key(user=USER, key=KEY):
    return f"habi:idem:booking:{user}:{key}"


@pytest.fixture(autouse=True)
def _patient(settings):
    settings.BOOKING_IDEMPOTENCY_WAIT_SECONDS = 0
    settings.BOOKING_IDEMPOTENCY_LOCK_SECONDS = 120
    settings.BOOKING_IDEMPOTENCY_TTL_SECONDS = 24 * 3600


def test_fifty_parallel_claims_one_runs_the_rest_see_it_in_progress(real_redis):
    outcomes = race(lambda i: idempotency.begin(USER, KEY, FP))
    runners = [v for kind, v in outcomes if kind == "ok" and v.token]
    assert len(runners) == 1
    others = [v for kind, v in outcomes if kind == "err"]
    assert len(others) == RACERS - 1
    assert all(isinstance(e, IdempotencyInProgress) for e in others), others
    assert json.loads(real_redis.get(redis_key()))["state"] == "in_progress"
    assert 0 < real_redis.ttl(redis_key()) <= 120


def test_waiting_duplicates_all_get_the_one_booking_after_it_completes(real_redis, settings):
    settings.BOOKING_IDEMPOTENCY_WAIT_SECONDS = 10
    booking_id = uuid.uuid4()
    ran = []

    def job(_i):
        started = idempotency.begin(USER, KEY, FP)
        if started.token:
            ran.append(started.token)
            time.sleep(0.4)  # the "work"
            idempotency.complete(USER, KEY, started.token, booking_id, FP)
            return booking_id
        return started.replay_booking_id

    outcomes = race(job, n=30)
    assert [kind for kind, _ in outcomes] == ["ok"] * 30, outcomes
    assert len(ran) == 1
    assert {value for _kind, value in outcomes} == {booking_id}


def test_a_finished_record_lives_24_hours(real_redis):
    started = idempotency.begin(USER, KEY, FP)
    idempotency.complete(USER, KEY, started.token, uuid.uuid4(), FP)
    assert 24 * 3600 - 10 < real_redis.ttl(redis_key()) <= 24 * 3600
    assert idempotency.begin(USER, KEY, FP).replay_booking_id is not None


@pytest.mark.parametrize("finish", [False, True])
def test_another_payload_is_a_conflict_in_both_states(real_redis, finish):
    started = idempotency.begin(USER, KEY, FP)
    if finish:
        idempotency.complete(USER, KEY, started.token, uuid.uuid4(), FP)
    with pytest.raises(IdempotencyConflict):
        idempotency.begin(USER, KEY, "another-fingerprint")


def test_release_frees_the_key_for_exactly_one_new_runner(real_redis):
    first = idempotency.begin(USER, KEY, FP)
    idempotency.release(USER, KEY, "not-the-owner-token")  # someone else's token: no effect
    assert real_redis.exists(redis_key())
    idempotency.release(USER, KEY, first.token)
    assert not real_redis.exists(redis_key())
    outcomes = race(lambda i: idempotency.begin(USER, KEY, FP))
    assert sum(1 for kind, v in outcomes if kind == "ok" and v.token) == 1


def test_a_stale_owner_cannot_overwrite_the_new_owner(real_redis):
    stale = idempotency.begin(USER, KEY, FP)
    real_redis.delete(redis_key())  # the marker expired while the old request was still running
    fresh = idempotency.begin(USER, KEY, FP)
    assert fresh.token and fresh.token != stale.token
    idempotency.complete(USER, KEY, stale.token, uuid.uuid4(), FP)  # must be ignored
    record = json.loads(real_redis.get(redis_key()))
    assert record["state"] == "in_progress" and record["token"] == fresh.token
    idempotency.release(USER, KEY, stale.token)  # also ignored
    assert real_redis.exists(redis_key())


def test_an_in_progress_marker_really_expires_when_the_process_died(real_redis, settings):
    settings.BOOKING_IDEMPOTENCY_LOCK_SECONDS = 1
    idempotency.begin(USER, KEY, FP)
    time.sleep(1.5)  # real Redis expiry, not a mocked clock
    assert idempotency.begin(USER, KEY, FP).token is not None


def test_refresh_pushes_the_expiry_out(real_redis, settings):
    settings.BOOKING_IDEMPOTENCY_LOCK_SECONDS = 3
    started = idempotency.begin(USER, KEY, FP)
    time.sleep(1.2)
    settings.BOOKING_IDEMPOTENCY_LOCK_SECONDS = 30
    idempotency.refresh(USER, KEY, started.token)
    assert real_redis.ttl(redis_key()) > 3


def test_a_corrupt_record_is_discarded_and_the_key_is_usable(real_redis):
    real_redis.set(redis_key(), "{not json")
    assert idempotency.begin(USER, KEY, FP).token is not None


def test_keys_are_scoped_to_the_user(real_redis):
    other = uuid.uuid4()
    assert idempotency.begin(USER, KEY, FP).token is not None
    assert idempotency.begin(other, KEY, FP).token is not None
