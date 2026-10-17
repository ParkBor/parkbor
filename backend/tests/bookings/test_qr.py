"""Signed one-time QR tokens (ARCHITECTURE 6.3, 15)."""

import json
import uuid
from datetime import timedelta
from unittest import mock

import pytest
from django.core import signing
from django.test import override_settings

from apps.bookings import qr
from apps.bookings.state import BookingStatus as S
from tests.bookings.factories import make_booking

pytestmark = pytest.mark.django_db


@pytest.fixture
def booking(driver, vehicle, world, window):
    return make_booking(
        user=driver,
        slot=world.slots[0],
        vehicle=vehicle,
        start=window[0],
        end=window[1],
        status=S.CONFIRMED,
    )


def lot_id_of(booking):
    return booking.slot.zone.parking_lot_id


class TestIssueAndVerify:
    def test_round_trip(self, booking, now):
        token, expires_at = qr.issue_token(booking)
        claims = qr.verify_token(token, now=now)
        assert claims.booking_id == booking.pk
        assert claims.lot_id == lot_id_of(booking)
        assert claims.nonce == booking.qr_nonce
        assert claims.expires_at == expires_at
        assert expires_at == booking.ends_at + timedelta(minutes=30)

    def test_lot_must_match_when_given(self, booking, now):
        token, _ = qr.issue_token(booking)
        assert qr.verify_token(token, expected_lot_id=lot_id_of(booking), now=now)
        with pytest.raises(qr.QrWrongLot):
            qr.verify_token(token, expected_lot_id=uuid.uuid4(), now=now)

    def test_expires_after_the_grace_period(self, booking, now):
        token, expires_at = qr.issue_token(booking)
        assert qr.verify_token(token, now=expires_at)  # the last valid instant
        with pytest.raises(qr.QrExpired):
            qr.verify_token(token, now=expires_at + timedelta(seconds=1))

    def test_grace_comes_from_settings(self, booking):
        with override_settings(BOOKING_QR_GRACE_MINUTES=5):
            _, expires_at = qr.issue_token(booking)
        assert expires_at == booking.ends_at + timedelta(minutes=5)

    def test_a_tampered_token_is_rejected(self, booking, now):
        token, _ = qr.issue_token(booking)
        payload, _, signature = token.rpartition(":")
        forged = payload[:-1] + ("A" if payload[-1] != "A" else "B") + ":" + signature
        with pytest.raises(qr.QrInvalid):
            qr.verify_token(forged, now=now)

    @pytest.mark.parametrize("garbage", ["", "abc", "a:b:c", "x" * 500, None, 123])
    def test_garbage_is_rejected(self, now, garbage):
        with pytest.raises(qr.QrInvalid):
            qr.verify_token(garbage, now=now)

    def test_a_token_signed_for_another_purpose_is_rejected(self, booking, now):
        other = signing.dumps(
            {"b": str(booking.pk), "l": str(lot_id_of(booking)), "n": "x", "e": 9999999999},
            salt="some.other.salt",
        )
        with pytest.raises(qr.QrInvalid):
            qr.verify_token(other, now=now)

    def test_a_token_signed_with_another_key_is_rejected(self, booking, now):
        token, _ = qr.issue_token(booking)
        with override_settings(QR_SIGNING_KEY="a-completely-different-qr-key-0123456789-abcdef"):
            with pytest.raises(qr.QrInvalid):
                qr.verify_token(token, now=now)

    def test_the_secret_key_alone_cannot_forge_a_qr_token(self, booking, now, settings):
        """QR tokens have their own key: a leaked SECRET_KEY (cookies/signing) is not enough."""
        payload = {
            "b": str(booking.pk),
            "l": str(booking.slot.zone.parking_lot_id),
            "n": booking.qr_nonce,
            "nb": 0,
            "e": 4_000_000_000,
        }
        forged = signing.dumps(payload, key=settings.SECRET_KEY, salt=qr.SALT)
        with pytest.raises(qr.QrInvalid):
            qr.verify_token(forged, now=now)

    def test_key_rotation_through_fallback_keys(self, booking, now, settings):
        token, _ = qr.issue_token(booking)
        old_key = settings.QR_SIGNING_KEY
        settings.QR_SIGNING_KEY = "a-brand-new-qr-signing-key-0123456789-abcdefghijklmnop"
        with pytest.raises(qr.QrInvalid):
            qr.verify_token(token, now=now)
        settings.QR_SIGNING_KEY_FALLBACKS = [old_key]
        assert qr.verify_token(token, now=now).booking_id == booking.pk

    def test_oversized_tokens_are_refused_before_parsing(self, now):
        with pytest.raises(qr.QrInvalid):
            qr.verify_token("a" * (qr.MAX_TOKEN_LENGTH + 1), now=now)

    def test_not_valid_before_the_early_window(self, booking, now):
        token, _ = qr.issue_token(booking)
        too_early = booking.starts_at - timedelta(hours=2, seconds=1)
        with pytest.raises(qr.QrNotYetValid):
            qr.verify_token(token, now=too_early)
        assert qr.verify_token(token, now=booking.starts_at - timedelta(hours=2))

    def test_early_window_comes_from_settings(self, booking, settings):
        settings.BOOKING_QR_EARLY_MINUTES = 10
        token, _ = qr.issue_token(booking)
        with pytest.raises(qr.QrNotYetValid):
            qr.verify_token(token, now=booking.starts_at - timedelta(minutes=11))

    def test_a_correctly_signed_but_malformed_payload_is_rejected(self, now):
        token = signing.dumps(
            {"b": "not-a-uuid", "l": "x", "n": "n", "nb": 0, "e": "never"},
            key=qr._key(),
            salt=qr.SALT,
        )
        with pytest.raises(qr.QrInvalid):
            qr.verify_token(token, now=now)

    def test_the_token_carries_no_personal_data(self, booking, driver, vehicle):
        token, _ = qr.issue_token(booking)
        raw = signing.loads(token, key=qr._key(), salt=qr.SALT)
        assert set(raw) == {"b", "l", "n", "nb", "e"}
        blob = json.dumps(raw)
        for secret in (str(driver.telegram_id), vehicle.plate_number, str(driver.pk)):
            assert secret not in blob


class TestOneTimeNonce:
    def test_a_nonce_is_consumed_once(self, booking, now, fake_redis):
        token, _ = qr.issue_token(booking)
        claims = qr.verify_token(token, now=now)
        assert qr.consume_nonce(claims, now=now) is True
        assert qr.consume_nonce(claims, now=now) is False

    def test_the_database_decides_even_if_redis_is_empty_or_down(self, booking, now, fake_redis):
        from redis.exceptions import RedisError

        claims = qr.verify_token(qr.issue_token(booking)[0], now=now)
        assert qr.consume_nonce(claims, now=now) is True
        fake_redis.flushall()  # Redis lost everything
        assert qr.consume_nonce(claims, now=now) is False
        with mock.patch.object(qr, "get_redis", side_effect=RedisError("down")):
            assert qr.consume_nonce(claims, now=now) is False
        booking.refresh_from_db()
        assert booking.qr_nonce_used_at == now

    def test_a_rolled_back_check_in_leaves_the_nonce_unspent(self, booking, now):
        from django.db import transaction

        claims = qr.verify_token(qr.issue_token(booking)[0], now=now)
        try:
            with transaction.atomic():
                assert qr.consume_nonce(claims, now=now) is True
                raise RuntimeError("check-in failed after the scan")
        except RuntimeError:
            pass
        assert qr.consume_nonce(claims, now=now) is True

    def test_rotating_the_nonce_revokes_old_tokens_and_unspends(self, booking, now):
        from apps.bookings import services

        old = qr.verify_token(qr.issue_token(booking)[0], now=now)
        assert qr.consume_nonce(old, now=now)
        rotated = services.rotate_qr_nonce(booking)
        assert rotated.qr_nonce != booking.qr_nonce
        assert rotated.qr_nonce_used_at is None
        assert not qr.claims_match_booking(old, rotated)
        new = qr.verify_token(qr.issue_token(rotated)[0], now=now)
        assert qr.claims_match_booking(new, rotated)
        assert qr.consume_nonce(new, now=now) is True

    def test_the_marker_lives_until_the_token_expires(
        self, booking, now, fake_redis, django_capture_on_commit_callbacks
    ):
        token, expires_at = qr.issue_token(booking)
        claims = qr.verify_token(token, now=now)
        with django_capture_on_commit_callbacks(execute=True):
            qr.consume_nonce(claims, now=now)
        (key,) = fake_redis.keys("habi:qr:used:*")
        ttl = fake_redis.ttl(key)
        assert 0 < ttl <= int((expires_at - now).total_seconds()) + 1

    def test_different_bookings_do_not_share_nonces(
        self, booking, driver, vehicle, world, window, now, fake_redis
    ):
        second = make_booking(
            user=driver,
            slot=world.slots[1],
            vehicle=vehicle,
            start=window[0],
            end=window[1],
            status=S.CONFIRMED,
            qr_nonce=booking.qr_nonce,
        )
        a = qr.verify_token(qr.issue_token(booking)[0], now=now)
        b = qr.verify_token(qr.issue_token(second)[0], now=now)
        assert qr.consume_nonce(a, now=now)
        assert qr.consume_nonce(b, now=now)


class TestMatchesBooking:
    def test_current_nonce_matches(self, booking, now):
        claims = qr.verify_token(qr.issue_token(booking)[0], now=now)
        assert qr.claims_match_booking(claims, booking)

    def test_rotated_nonce_invalidates_old_tokens(self, booking, now):
        claims = qr.verify_token(qr.issue_token(booking)[0], now=now)
        booking.qr_nonce = "another-nonce-another-nonce"
        assert not qr.claims_match_booking(claims, booking)

    def test_wrong_booking_or_lot_does_not_match(
        self, booking, driver, vehicle, world, window, now
    ):
        claims = qr.verify_token(qr.issue_token(booking)[0], now=now)
        other = make_booking(
            user=driver,
            slot=world.slots[1],
            vehicle=vehicle,
            start=window[0],
            end=window[1],
            status=S.CONFIRMED,
            qr_nonce=booking.qr_nonce,
        )
        assert not qr.claims_match_booking(claims, other)
