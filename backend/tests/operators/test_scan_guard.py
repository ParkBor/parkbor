"""Brute-force protection of CHECK-IN, per-minute throttles and operator policy."""

import logging
import uuid
from datetime import timedelta

import pytest
from django.core.cache import cache

from apps.bookings import services
from apps.bookings.qr import QrForged
from apps.bookings.state import BookingStatus as S
from apps.core import attempts
from apps.core.exceptions import ApiError
from apps.operators import scan_guard
from apps.parking.models import OperatorAssignment
from tests.bookings.factories import make_vehicle, make_world
from tests.helpers import client_for, make_user
from tests.operators.helpers import book, entry_token

pytestmark = pytest.mark.django_db

CHECKIN = "/api/v1/operator/checkin"
CHECKOUT = "/api/v1/operator/checkout"
LIMIT = 10


def forged_token(gate):
    """Shaped exactly like one of our tokens, but with a wrong signature."""
    good = entry_token(book(gate))
    head, signature = good.rsplit(":", 1)
    return f"{head}:{signature[:-1]}{'A' if signature[-1] != 'A' else 'B'}"


def forge(api, gate, times, *, vary_lot=False):
    token = forged_token(gate)
    codes = []
    for _ in range(times):
        body = {"qr_token": token}
        if vary_lot:
            body["parking_lot_id"] = str(uuid.uuid4())  # a fresh made-up lot on every try
        codes.append(api.post(CHECKIN, body, format="json").status_code)
    return codes


def ghost_checkout(api, times):
    return [
        api.post(
            CHECKOUT,
            {"booking_id": str(uuid.uuid4()), "plate_number": "01A123BC"},
            format="json",
        ).status_code
        for _ in range(times)
    ]


# --- what counts and what locks -----------------------------------------------------------------


def test_ten_forged_scans_lock_check_in_with_429(gate):
    api = client_for(gate.operator)

    codes = forge(api, gate, LIMIT + 1)

    assert codes[:LIMIT] == [400] * LIMIT
    assert codes[LIMIT] == 429


def test_a_fresh_made_up_lot_id_on_every_try_does_not_dodge_the_lock(gate):
    api = client_for(gate.operator)

    codes = forge(api, gate, LIMIT + 1, vary_lot=True)

    # a lot the operator does not serve is wrong_lot (409, not counted as forging) only AFTER the
    # signature is checked; the forged signature is rejected first (400) and counted per operator
    assert codes[:LIMIT] == [400] * LIMIT
    assert codes[LIMIT] == 429


def test_the_lock_blocks_even_a_valid_code_and_says_when_to_retry(gate):
    api = client_for(gate.operator)
    forge(api, gate, LIMIT)
    booking = book(gate)

    response = api.post(CHECKIN, {"qr_token": entry_token(booking)}, format="json")

    assert response.status_code == 429
    assert response.json()["code"] == "scan_locked"
    assert int(response["Retry-After"]) >= 1
    booking.refresh_from_db()
    assert booking.status == S.CONFIRMED


def test_cars_can_always_leave_even_when_check_in_is_locked(gate):
    api = client_for(gate.operator)
    forge(api, gate, LIMIT)
    assert forge(api, gate, 1) == [429]
    booking = book(
        gate,
        status=S.ACTIVE,
        start_min=-60,
        end_min=60,
        checked_in_at=gate.now - timedelta(minutes=60),
    )
    from tests.operators.helpers import exit_token

    response = api.post(CHECKOUT, {"qr_token": exit_token(booking, gate.now)}, format="json")

    assert response.status_code == 200


def test_guessed_booking_ids_at_check_out_never_lock_anything_but_are_audited(gate):
    from apps.audit.models import AuditLog

    api = client_for(gate.operator)

    assert set(ghost_checkout(api, LIMIT + 3)) == {404}  # check-out itself is never locked
    booking = book(gate)

    response = api.post(CHECKIN, {"qr_token": entry_token(booking)}, format="json")

    assert response.status_code == 200  # a separate counter: entry is not locked by exit guessing
    assert AuditLog.objects.filter(action="operator.scan_suspicious").count() == 1


def refusals():
    from apps.bookings import gate_errors as errors

    return [
        errors.WrongLot(),
        errors.QrOutdated(),
        errors.QrAlreadyUsed(),
        errors.PlateMismatch(),
        errors.BookingExpired(),
        errors.TooEarly(),
        errors.SlotOccupied(),
    ]


@pytest.mark.parametrize("honest", refusals(), ids=lambda e: type(e).__name__)
def test_honest_refusals_never_count(gate, honest):
    for _ in range(LIMIT * 2):
        scan_guard.record_failure(gate.operator, honest)

    scan_guard.assert_open(gate.operator)  # still open


def test_bystanders_and_other_qr_codes_never_count(gate):
    api = client_for(gate.operator)
    scraps = [
        "hello",
        "https://example.com/menu?table=4",
        "BEGIN:VCARD",
        "a:b",  # two parts only
        "x" * 300,
        "not a token: at all: really",  # three parts, but not URL-safe
        "01A123BC",
    ]

    codes = [
        api.post(CHECKIN, {"qr_token": scrap}, format="json").status_code
        for _ in range(4)
        for scrap in scraps
    ]

    assert set(codes) == {400}  # refused, never locked (28 tries > the limit)
    booking = book(gate)
    assert api.post(CHECKIN, {"qr_token": entry_token(booking)}, format="json").status_code == 200


def test_only_token_shaped_input_is_ever_called_forged(gate):
    from apps.bookings import qr

    assert qr.looks_like_token(forged_token(gate))
    assert not any(
        qr.looks_like_token(text)
        for text in ("", "abc", "a:b", "a:b:c:d", "a b:c:d", "https://x.y/z", "é:é:é")
    )


def test_a_queue_of_wrong_lot_scans_does_not_lock_the_operator(gate):
    other = make_world(slots=1)
    other_driver = make_user("DRIVER")
    foreign = book(gate, slot=other.slots[0], user=other_driver, vehicle=make_vehicle(other_driver))
    api = client_for(gate.operator)
    token = entry_token(foreign)

    codes = [api.post(CHECKIN, {"qr_token": token}, format="json").status_code for _ in range(25)]

    assert set(codes) == {409}


def test_a_colleague_is_not_affected(gate):
    colleague = make_user("OPERATOR")
    OperatorAssignment.objects.create(operator=colleague, parking_lot=gate.lot)
    forge(client_for(gate.operator), gate, LIMIT + 2)
    booking = book(gate)

    response = client_for(colleague).post(
        CHECKIN, {"qr_token": entry_token(booking)}, format="json"
    )

    assert response.status_code == 200


def test_the_lock_ends_with_the_window(gate):
    api = client_for(gate.operator)
    forge(api, gate, LIMIT)
    assert forge(api, gate, 1) == [429]

    cache.clear()  # what the end of the window does to the counter

    assert forge(api, gate, 1) == [400]


def test_the_moment_of_locking_is_audited_once(gate, caplog, django_capture_on_commit_callbacks):
    from apps.audit.models import AuditLog

    api = client_for(gate.operator)

    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        forge(api, gate, LIMIT + 3)

    locks = [r for r in caplog.records if r.getMessage() == "audit operator.scan_locked"]
    assert len(locks) == 1
    assert locks[0].audit_actor == str(gate.operator.id)
    assert AuditLog.objects.filter(action="operator.scan_locked").count() == 1
    assert "forged-" not in " ".join(str(r.__dict__) for r in caplog.records)
    # forged codes are logged only: no database row per try
    assert not AuditLog.objects.filter(action="operator.checkin").exists()


def test_a_failing_audit_never_replaces_the_api_answer(gate, monkeypatch):
    def broken(**_kwargs):
        raise RuntimeError("audit table is down")

    monkeypatch.setattr(scan_guard, "audit", broken)
    api = client_for(gate.operator)

    codes = forge(api, gate, LIMIT + 1)

    assert codes[:LIMIT] == [400] * LIMIT  # the 10th failure still answers 400, not 500
    assert codes[LIMIT] == 429


# --- the counter itself --------------------------------------------------------------------------


def test_a_counter_without_an_end_marker_is_open_not_locked_for_ever(gate):
    counter = attempts.FailureCounter("probe", 3, 60)
    cache.set("habi:probe:n:k", 99, None)  # a count that lost its TTL / end marker

    assert counter.seconds_locked("k") == 0
    assert cache.get("habi:probe:n:k") is None  # and the orphan is removed


def test_a_counter_that_expires_between_add_and_incr_starts_a_new_window(monkeypatch):
    counter = attempts.FailureCounter("probe2", 3, 60)
    counter.record("k")
    real_incr = cache.incr

    def vanished(key, delta=1):
        cache.delete(key)
        return real_incr(key, delta)  # now raises ValueError like an expired key

    monkeypatch.setattr(cache, "incr", vanished)

    assert counter.record("k") == 1  # not an error, not a TTL-less key
    assert cache.get("habi:probe2:until:k") is not None


def test_every_counter_key_is_created_with_a_time_to_live():
    counter = attempts.FailureCounter("probe3", 3, 60)

    counter.record("k")

    # LocMem has no TTL read; the end marker doubles as proof and is always written with the count
    assert cache.get("habi:probe3:n:k") == 1
    assert cache.get("habi:probe3:until:k") is not None


def test_guard_fails_open_when_the_cache_is_down(gate, monkeypatch):
    class DownCache:
        def __getattr__(self, name):
            raise ConnectionError("cache down")

    monkeypatch.setattr(attempts, "cache", DownCache())

    scan_guard.assert_open(gate.operator)  # must not raise
    scan_guard.record_failure(gate.operator, QrForged())  # must not raise


# --- throttles ------------------------------------------------------------------------------------


def test_60_scans_a_minute_per_user_then_429(gate):
    api = client_for(gate.operator)
    cancelled = book(gate, status=S.CANCELLED)
    token = entry_token(cancelled)

    codes = [api.post(CHECKIN, {"qr_token": token}, format="json").status_code for _ in range(61)]

    assert 429 not in codes[:60]
    assert codes[60] == 429


def test_the_scan_budget_is_shared_by_checkin_and_checkout(gate):
    api = client_for(gate.operator)
    cancelled = book(gate, status=S.CANCELLED)
    token = entry_token(cancelled)
    for _ in range(60):
        api.post(CHECKIN, {"qr_token": token}, format="json")

    response = api.post(
        CHECKOUT,
        {"booking_id": str(cancelled.pk), "plate_number": cancelled.vehicle_plate},
        format="json",
    )

    assert response.status_code == 429


def test_other_users_have_their_own_throttle_budget(gate):
    api = client_for(gate.operator)
    cancelled = book(gate, status=S.CANCELLED)
    token = entry_token(cancelled)
    for _ in range(61):
        api.post(CHECKIN, {"qr_token": token}, format="json")

    assert (
        client_for(gate.owner).post(CHECKIN, {"qr_token": token}, format="json").status_code == 409
    )


# --- policy: staff cannot trade with their own lot ---------------------------------------------


def test_operator_cannot_book_a_slot_in_the_lot_they_serve(gate):
    with pytest.raises(ApiError) as exc:
        services.create_booking(
            user=gate.operator,
            lot_id=gate.lot.pk,
            slot_type="STANDARD",
            vehicle=make_vehicle(gate.operator),
            start=gate.now + timedelta(hours=1),
            end=gate.now + timedelta(hours=2),
            now=gate.now,
        )

    assert (exc.value.status_code, str(exc.value.detail["code"])) == (422, "own_lot_booking")


def test_revoked_operator_can_book_there_again(gate):
    OperatorAssignment.objects.filter(operator=gate.operator).update(revoked_at=gate.now)

    booking = services.create_booking(
        user=gate.operator,
        lot_id=gate.lot.pk,
        slot_type="STANDARD",
        vehicle=make_vehicle(gate.operator),
        start=gate.now + timedelta(hours=1),
        end=gate.now + timedelta(hours=2),
        now=gate.now,
    )

    assert booking.status == S.PENDING_PAYMENT


def test_operator_of_another_lot_can_book_here(gate):
    elsewhere = make_world(slots=1)
    visitor = make_user("OPERATOR")
    OperatorAssignment.objects.create(operator=visitor, parking_lot=elsewhere.lot)

    booking = services.create_booking(
        user=visitor,
        lot_id=gate.lot.pk,
        slot_type="STANDARD",
        vehicle=make_vehicle(visitor),
        start=gate.now + timedelta(hours=1),
        end=gate.now + timedelta(hours=2),
        now=gate.now,
    )

    assert booking.status == S.PENDING_PAYMENT
