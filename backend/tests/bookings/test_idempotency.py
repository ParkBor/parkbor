"""Idempotency-Key store (Redis, 24 h) and the idempotent create flow (ARCHITECTURE 10.3)."""

import threading
import uuid
from datetime import timedelta
from unittest import mock

import pytest

from apps.bookings import idempotency, services
from apps.bookings.errors import (
    IdempotencyConflict,
    IdempotencyInProgress,
    IdempotencyKeyError,
    NoSlotAvailable,
)
from apps.bookings.models import Booking
from tests.bookings.factories import make_vehicle
from tests.helpers import make_user

KEY = "7c1e5d6a-1111-4222-8333-944455556666"
USER = uuid.uuid4()
FP = "fingerprint-a"


class TestKeyValidation:
    @pytest.mark.parametrize("key", [KEY, "abcdefgh", "A" * 128, "a_b-c.d:e12345"])
    def test_valid(self, key):
        assert idempotency.validate_key(key) == key

    @pytest.mark.parametrize(
        ("key", "code"),
        [
            (None, "idempotency_key_required"),
            ("", "idempotency_key_required"),
            ("   ", "idempotency_key_required"),
            ("short", "idempotency_key_invalid"),
            ("A" * 129, "idempotency_key_invalid"),
            ("has space in it", "idempotency_key_invalid"),
            ("semi;colon-key1", "idempotency_key_invalid"),
            ("unicodé-key-123", "idempotency_key_invalid"),
            ("new\nline-key-123", "idempotency_key_invalid"),
        ],
    )
    def test_invalid(self, key, code):
        with pytest.raises(IdempotencyKeyError) as info:
            idempotency.validate_key(key)
        assert info.value.status_code == 400
        assert str(info.value.detail["code"]) == code

    def test_surrounding_whitespace_is_trimmed(self):
        assert idempotency.validate_key(f"  {KEY}  ") == KEY


class TestStore:
    @pytest.fixture(autouse=True)
    def _no_wait(self, settings):
        settings.BOOKING_IDEMPOTENCY_WAIT_SECONDS = 0

    def test_first_call_starts_and_a_parallel_duplicate_gets_409(self, fake_redis):
        started = idempotency.begin(USER, KEY, FP)
        assert started.replay_booking_id is None
        with pytest.raises(IdempotencyInProgress) as info:
            idempotency.begin(USER, KEY, FP)
        assert info.value.status_code == 409
        assert str(info.value.detail["code"]) == "idempotency_in_progress"

    def test_completed_key_replays_the_booking_id(self, fake_redis):
        started = idempotency.begin(USER, KEY, FP)
        booking_id = uuid.uuid4()
        idempotency.complete(USER, KEY, started.token, booking_id)
        replay = idempotency.begin(USER, KEY, FP)
        assert replay.replay_booking_id == booking_id

    def test_same_key_with_another_payload_is_422(self, fake_redis):
        idempotency.begin(USER, KEY, FP)
        with pytest.raises(IdempotencyConflict) as info:
            idempotency.begin(USER, KEY, "fingerprint-b")
        assert info.value.status_code == 422
        assert str(info.value.detail["code"]) == "idempotency_conflict"

    def test_conflict_is_detected_after_completion_too(self, fake_redis):
        started = idempotency.begin(USER, KEY, FP)
        idempotency.complete(USER, KEY, started.token, uuid.uuid4())
        with pytest.raises(IdempotencyConflict):
            idempotency.begin(USER, KEY, "fingerprint-b")

    def test_keys_are_scoped_per_user(self, fake_redis):
        idempotency.begin(USER, KEY, FP)
        assert idempotency.begin(uuid.uuid4(), KEY, FP).replay_booking_id is None

    def test_release_lets_the_client_retry(self, fake_redis):
        started = idempotency.begin(USER, KEY, FP)
        idempotency.release(USER, KEY, started.token)
        assert idempotency.begin(USER, KEY, FP).replay_booking_id is None

    def test_release_with_a_stale_token_does_not_remove_someone_elses_lock(self, fake_redis):
        idempotency.begin(USER, KEY, FP)
        idempotency.release(USER, KEY, "stale-token")
        with pytest.raises(IdempotencyInProgress):
            idempotency.begin(USER, KEY, FP)

    def test_completed_record_lives_24_hours_and_the_lock_is_short(self, fake_redis):
        started = idempotency.begin(USER, KEY, FP)
        (key,) = fake_redis.keys("habi:idem:booking:*")
        assert 30 < fake_redis.ttl(key) <= 120  # far above lock_timeout + statement_timeout
        idempotency.complete(USER, KEY, started.token, uuid.uuid4())
        assert 24 * 3600 - 5 <= fake_redis.ttl(key) <= 24 * 3600

    def test_refresh_extends_only_our_own_marker(self, fake_redis):
        started = idempotency.begin(USER, KEY, FP)
        (key,) = fake_redis.keys("habi:idem:booking:*")
        fake_redis.expire(key, 5)
        idempotency.refresh(USER, KEY, started.token)
        assert fake_redis.ttl(key) > 30
        fake_redis.expire(key, 5)
        idempotency.refresh(USER, KEY, "someone-elses-token")
        assert fake_redis.ttl(key) <= 5

    def test_complete_by_a_stale_owner_does_not_overwrite_the_new_owner(self, fake_redis):
        first = idempotency.begin(USER, KEY, FP)
        (key,) = fake_redis.keys("habi:idem:booking:*")
        fake_redis.delete(key)  # the marker expired while the first request was still running
        second = idempotency.begin(USER, KEY, FP)
        idempotency.complete(USER, KEY, first.token, uuid.uuid4(), FP)  # stale: ignored
        with pytest.raises(IdempotencyInProgress):
            idempotency.begin(USER, KEY, FP)
        booking_id = uuid.uuid4()
        idempotency.complete(USER, KEY, second.token, booking_id, FP)
        assert idempotency.begin(USER, KEY, FP).replay_booking_id == booking_id

    @pytest.mark.parametrize(
        "garbage",
        [
            "not json",
            "[]",
            '{"state": "done"}',
            '{"fp": "x", "state": "weird"}',
            '{"fp": "x", "state": "done", "booking_id": "nope"}',
        ],
    )
    def test_a_corrupt_record_is_discarded_and_the_request_starts_afresh(self, fake_redis, garbage):
        fake_redis.set(f"habi:idem:booking:{USER}:{KEY}", garbage)
        assert idempotency.begin(USER, KEY, FP).token

    def test_a_marker_that_vanished_can_still_be_completed_with_the_fingerprint(self, fake_redis):
        started = idempotency.begin(USER, KEY, FP)
        fake_redis.flushall()
        booking_id = uuid.uuid4()
        idempotency.complete(USER, KEY, started.token, booking_id, FP)
        assert idempotency.begin(USER, KEY, FP).replay_booking_id == booking_id

    def test_a_crashed_request_does_not_block_forever(self, fake_redis):
        idempotency.begin(USER, KEY, FP)
        (key,) = fake_redis.keys("habi:idem:booking:*")
        fake_redis.expire(key, 1)
        fake_redis.delete(key)  # what the 30 s lock expiry does
        assert idempotency.begin(USER, KEY, FP).replay_booking_id is None

    def test_exactly_one_of_many_parallel_starters_wins(self, fake_redis):
        results, lock = [], threading.Lock()

        def attempt():
            try:
                outcome = idempotency.begin(USER, KEY, FP)
                value = "started" if outcome.replay_booking_id is None else "replay"
            except IdempotencyInProgress:
                value = "in_progress"
            with lock:
                results.append(value)

        threads = [threading.Thread(target=attempt) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert results.count("started") == 1
        assert results.count("in_progress") == 19

    def test_a_waiting_duplicate_gets_the_result_when_the_first_finishes(
        self, fake_redis, settings
    ):
        settings.BOOKING_IDEMPOTENCY_WAIT_SECONDS = 1.0
        started = idempotency.begin(USER, KEY, FP)
        booking_id = uuid.uuid4()
        timer = threading.Timer(0.2, idempotency.complete, (USER, KEY, started.token, booking_id))
        timer.start()
        try:
            assert idempotency.begin(USER, KEY, FP).replay_booking_id == booking_id
        finally:
            timer.join()


@pytest.mark.django_db
class TestIdempotentCreate:
    @pytest.fixture(autouse=True)
    def _no_wait(self, settings):
        settings.BOOKING_IDEMPOTENCY_WAIT_SECONDS = 0

    def params(self, driver, vehicle, world, window, now, **extra):
        return {
            "user": driver,
            "lot_id": world.lot.pk,
            "slot_type": "STANDARD",
            "vehicle": vehicle,
            "start": window[0],
            "end": window[1],
            "now": now,
            **extra,
        }

    def test_same_key_same_payload_returns_the_same_booking(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        first, created1 = services.create_booking_idempotent(
            idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
        )
        second, created2 = services.create_booking_idempotent(
            idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
        )
        assert (created1, created2) == (True, False)
        assert first.pk == second.pk
        assert Booking.objects.count() == 1

    def test_an_equivalent_time_notation_is_the_same_payload(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        from zoneinfo import ZoneInfo

        tz = ZoneInfo("Asia/Tashkent")
        first, _ = services.create_booking_idempotent(
            idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
        )
        again, created = services.create_booking_idempotent(
            idempotency_key=KEY,
            **self.params(
                driver, vehicle, world, (window[0].astimezone(tz), window[1].astimezone(tz)), now
            ),
        )
        assert not created
        assert again.pk == first.pk

    def test_same_key_different_payload_is_422_and_creates_nothing_new(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        services.create_booking_idempotent(
            idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
        )
        later = (window[0] + timedelta(days=1), window[1] + timedelta(days=1))
        with pytest.raises(IdempotencyConflict):
            services.create_booking_idempotent(
                idempotency_key=KEY, **self.params(driver, vehicle, world, later, now)
            )
        assert Booking.objects.count() == 1

    def test_a_failed_attempt_releases_the_key(self, driver, vehicle, window, now, fake_redis):
        from tests.bookings.factories import make_world

        world = make_world(slots=0)
        params = self.params(driver, vehicle, world, window, now)
        with pytest.raises(NoSlotAvailable):
            services.create_booking_idempotent(idempotency_key=KEY, **params)
        assert not fake_redis.keys("habi:idem:booking:*")

    def test_a_retry_after_a_failure_creates_the_booking(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        with mock.patch.object(services, "create_booking", side_effect=NoSlotAvailable):
            with pytest.raises(NoSlotAvailable):
                services.create_booking_idempotent(
                    idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
                )
        booking, created = services.create_booking_idempotent(
            idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
        )
        assert created
        assert booking.pk

    def test_two_users_may_reuse_the_same_key(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        other = make_user("DRIVER")
        a, _ = services.create_booking_idempotent(
            idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
        )
        b, created = services.create_booking_idempotent(
            idempotency_key=KEY,
            **self.params(other, make_vehicle(other), world, window, now),
        )
        assert created
        assert a.pk != b.pk

    def test_an_in_flight_duplicate_is_409_and_does_not_create(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        fp = idempotency.fingerprint(self.params(driver, vehicle, world, window, now))
        idempotency.begin(driver.pk, KEY, fp)  # the "other request" is still running
        with pytest.raises(IdempotencyInProgress):
            services.create_booking_idempotent(
                idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
            )
        assert not Booking.objects.exists()

    def test_a_failing_release_does_not_mask_the_real_error(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        with mock.patch.object(services, "create_booking", side_effect=NoSlotAvailable):
            with mock.patch.object(idempotency, "release", side_effect=RuntimeError("redis")):
                with pytest.raises(NoSlotAvailable):
                    services.create_booking_idempotent(
                        idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
                    )

    def test_a_replay_shows_the_booking_as_it_is_now(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        from apps.bookings.state import BookingStatus

        first, _ = services.create_booking_idempotent(
            idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
        )
        services.cancel_booking(booking_id=first.pk, user=driver, now=now)
        again, created = services.create_booking_idempotent(
            idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
        )
        assert not created
        assert again.status == BookingStatus.CANCELLED  # the client sees the truth

    def test_a_redis_outage_while_recording_does_not_lose_the_booking(
        self, driver, vehicle, world, window, now, fake_redis
    ):
        from redis.exceptions import RedisError

        with mock.patch.object(idempotency, "complete", side_effect=RedisError("down")):
            booking, created = services.create_booking_idempotent(
                idempotency_key=KEY, **self.params(driver, vehicle, world, window, now)
            )
        assert created
        assert Booking.objects.filter(pk=booking.pk).exists()
