"""Check-in (ARCHITECTURE 6.3, 10.8 Step 9): QR -> ACTIVE, one transaction, lot lock first."""

import logging
from datetime import timedelta

import pytest
from django.db.models import QuerySet
from redis.exceptions import ConnectionError as RedisConnectionError

from apps.accounts.models import User
from apps.bookings import checkin, qr, services
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingStatus as S
from apps.core.exceptions import ApiError
from apps.parking.models import LotStatus, OperatorAssignment, ParkingLot, Slot, SlotStatus
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_lot, make_user
from tests.operators.helpers import book, entry_token, make_gate

pytestmark = pytest.mark.django_db


def scan(gate, booking, *, operator=None, token=None, **kwargs):
    return checkin.check_in(
        operator=operator or gate.operator,
        token=token or entry_token(booking),
        now=kwargs.pop("now", gate.now),
        **kwargs,
    )


def code_of(exc_info) -> str:
    return str(exc_info.value.detail["code"])


# --- success ----------------------------------------------------------------------------------


def test_check_in_activates_the_booking_and_occupies_the_slot(gate):
    booking = book(gate)

    result = scan(gate, booking)

    booking.refresh_from_db()
    assert (result.code, result.already_checked_in) == ("checked_in", False)
    assert booking.status == S.ACTIVE
    assert booking.checked_in_at == gate.now
    slot = Slot.objects.get(pk=gate.slot.pk)
    assert slot.status == SlotStatus.OCCUPIED
    assert ParkingLot.objects.get(pk=gate.lot.pk).free_slots == 1  # was 2, one slot now taken


def test_check_in_logs_the_operator_as_actor(gate):
    booking = book(gate)

    scan(gate, booking)

    event = BookingEvent.objects.get(booking=booking, to_status=S.ACTIVE)
    assert event.actor_id == gate.operator.id
    assert (event.from_status, event.reason) == (S.CONFIRMED, "checked_in")
    assert event.meta["slot"] == str(gate.slot.id)


def test_check_in_rotates_the_nonce_for_the_exit_code(gate):
    booking = book(gate)
    old_nonce = booking.qr_nonce

    scan(gate, booking)

    booking.refresh_from_db()
    assert booking.qr_nonce != old_nonce
    assert booking.qr_nonce_used_at is None  # the new (exit) nonce is unspent


def test_check_in_allowed_exactly_at_the_early_limit(gate):
    booking = book(gate, start_min=30, end_min=150)

    assert scan(gate, booking).code == "checked_in"


def test_owner_and_admin_may_check_in_too(gate):
    booking = book(gate)
    admin = make_user("ADMIN")

    assert scan(gate, booking, operator=gate.owner).code == "checked_in"
    assert scan(gate, booking, operator=admin, token=entry_token(booking)).already_checked_in


def test_operator_assigned_to_two_lots_checks_in_in_either(gate):
    other = make_world(slots=1)
    OperatorAssignment.objects.create(operator=gate.operator, parking_lot=other.lot)
    vehicle = make_vehicle(gate.driver)
    booking = make_booking(
        user=gate.driver,
        slot=other.slots[0],
        vehicle=vehicle,
        start=gate.now - timedelta(minutes=5),
        end=gate.now + timedelta(hours=2),
        status=S.CONFIRMED,
    )

    assert scan(gate, booking).code == "checked_in"


# --- idempotent repeat ------------------------------------------------------------------------


def test_scanning_twice_is_harmless_and_spends_no_new_nonce(gate):
    booking = book(gate)
    token = entry_token(booking)
    scan(gate, booking, token=token)
    after_first = Booking.objects.get(pk=booking.pk)

    second = scan(gate, booking, token=token, now=gate.now + timedelta(minutes=3))

    after_second = Booking.objects.get(pk=booking.pk)
    assert (second.code, second.already_checked_in) == ("already_checked_in", True)
    assert after_second.qr_nonce == after_first.qr_nonce
    assert after_second.qr_nonce_used_at is None
    assert after_second.checked_in_at == after_first.checked_in_at
    assert BookingEvent.objects.filter(booking=booking, to_status=S.ACTIVE).count() == 1


def test_a_repeat_scan_is_recognised_but_is_not_an_admission(gate):
    booking = book(gate)
    token = entry_token(booking)
    first = scan(gate, booking, token=token)

    second = scan(gate, booking, token=token, now=gate.now + timedelta(minutes=1))

    assert (first.allowed, second.allowed) == (True, False)
    assert second.code == "already_checked_in"


def test_the_spent_entry_nonce_is_remembered_only_as_a_hash(gate):
    booking = book(gate)
    old_nonce = booking.qr_nonce

    scan(gate, booking)

    booking.refresh_from_db()
    assert booking.checkin_nonce_hash == qr.nonce_hash(old_nonce)
    assert old_nonce not in (booking.checkin_nonce_hash, booking.qr_nonce)


def test_another_entry_code_of_a_booking_that_is_inside_is_outdated_not_amber(gate):
    booking = book(gate)
    stale = entry_token(booking)  # issued before the driver asked for a new code
    services.rotate_qr_nonce(booking)
    booking.refresh_from_db()
    fresh = entry_token(booking)
    scan(gate, booking, token=fresh)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, token=stale)

    assert code_of(exc) == "qr_outdated"  # no hint that the booking is inside


def test_a_booking_inside_that_has_no_recorded_entry_nonce_is_outdated(gate):
    booking = book(gate, status=S.OVERSTAY, start_min=-130, end_min=-10, checked_in_at=gate.now)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, token=entry_token(booking))

    assert code_of(exc) == "qr_outdated"


def test_the_screenshot_of_a_used_code_never_opens_the_gate_twice(gate):
    booking = book(gate)
    screenshot = entry_token(booking)
    outcomes = [scan(gate, booking, token=screenshot).allowed]
    for minute in (1, 2, 30):
        outcomes.append(
            scan(gate, booking, token=screenshot, now=gate.now + timedelta(minutes=minute)).allowed
        )

    assert outcomes == [True, False, False, False]


def test_plate_typed_by_the_operator_must_match_the_booking(gate):
    booking = book(gate, vehicle=make_vehicle(gate.driver, plate="01A123BC"))

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, plate_number="99Z999ZZ")
    assert (exc.value.status_code, code_of(exc)) == (409, "plate_mismatch")
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED  # nothing spent

    assert scan(gate, booking, plate_number=" 01 a-123 bc ").code == "checked_in"


def test_plate_is_compared_for_a_repeat_scan_too(gate):
    booking = book(gate)
    token = entry_token(booking)
    scan(gate, booking, token=token)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, token=token, plate_number="99Z999ZZ")

    assert code_of(exc) == "plate_mismatch"


def test_the_fresh_nonce_and_its_hash_never_reach_the_audit_log(
    gate, caplog, django_capture_on_commit_callbacks
):
    booking = book(gate)
    old_nonce = booking.qr_nonce

    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        scan(gate, booking)

    booking.refresh_from_db()
    everything = " ".join(str(r.__dict__) for r in caplog.records)
    for secret in (old_nonce, booking.qr_nonce, booking.checkin_nonce_hash):
        assert secret not in everything
    from apps.audit.models import AuditLog

    assert all(
        secret not in str(row.meta)
        for row in AuditLog.objects.all()
        for secret in (old_nonce, booking.qr_nonce, booking.checkin_nonce_hash)
    )


def test_check_in_is_one_update_of_the_booking_row_besides_the_nonce_spend(gate):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    booking = book(gate)

    with CaptureQueriesContext(connection) as queries:
        scan(gate, booking)

    updates = [q["sql"] for q in queries if q["sql"].startswith('UPDATE "bookings_booking"')]
    assert len(updates) == 2  # consume_nonce (the atomic spend) + ONE transition/rotation update


# --- the table: status x token/time x lot -----------------------------------------------------

STATUS_CODES = [
    (S.PENDING_PAYMENT, "booking_not_paid"),
    (S.EXPIRED, "booking_expired"),
    (S.CANCELLED, "booking_cancelled"),
    (S.NO_SHOW, "booking_no_show"),
    (S.COMPLETED, "booking_completed"),
]


@pytest.mark.parametrize(("status", "code"), STATUS_CODES)
def test_non_confirmed_statuses_are_refused_with_their_own_code(gate, status, code):
    booking = book(gate, status=status, hold_expires_at=None)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == code
    assert exc.value.status_code == 409
    assert Booking.objects.get(pk=booking.pk).status == status
    assert Slot.objects.get(pk=gate.slot.pk).status == SlotStatus.FREE


def test_too_early_one_minute_before_the_limit(gate):
    booking = book(gate, start_min=31, end_min=151)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "too_early"
    assert exc.value.status_code == 409
    assert Booking.objects.get(pk=booking.pk).qr_nonce_used_at is None


def test_booking_over_when_the_period_has_ended(gate):
    booking = book(gate, start_min=-150, end_min=-10)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "booking_over"


def test_booking_over_exactly_at_the_end(gate):
    booking = book(gate, start_min=-60, end_min=0)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "booking_over"


def test_late_arrival_past_the_no_show_grace_is_a_no_show_even_before_the_sweep(gate):
    booking = book(gate, start_min=-21, end_min=100)  # grace is 20 minutes (sweep: strictly after)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "booking_no_show"
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED  # the sweep does the change


def test_arrival_exactly_at_the_end_of_the_grace_is_fine(gate):
    booking = book(gate, start_min=-20, end_min=100)

    assert scan(gate, booking).code == "checked_in"


# --- token problems ---------------------------------------------------------------------------


@pytest.mark.parametrize("garbage", ["", "abc", "a" * 2000, "x.y.z"])
def test_garbage_tokens_are_qr_invalid(gate, garbage):
    with pytest.raises(ApiError) as exc:
        checkin.check_in(operator=gate.operator, token=garbage, now=gate.now)

    assert code_of(exc) == "qr_invalid"


def test_token_signed_with_another_key_is_qr_invalid(gate, settings):
    booking = book(gate)
    token = entry_token(booking)
    settings.QR_SIGNING_KEY = "another-key-0123456789abcdef-0123456789abcdef-0123456789abcdef"

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, token=token)

    assert code_of(exc) == "qr_invalid"


def test_expired_token(gate):
    booking = book(gate, start_min=-200, end_min=-100)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)  # token ended 30 minutes after the booking: 70 minutes ago

    assert code_of(exc) == "qr_expired"


def test_token_not_yet_valid(gate):
    booking = book(gate, start_min=121, end_min=240)  # opens 120 minutes before the start

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "qr_not_yet_valid"


def test_exit_token_is_refused_at_the_entrance(gate):
    booking = book(gate, status=S.ACTIVE, checked_in_at=gate.now)
    token = qr.issue_exit_token(booking, now=gate.now)[0]

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, token=token)

    assert code_of(exc) == "qr_wrong_purpose"


def test_replaced_token_is_qr_outdated(gate):
    booking = book(gate)
    old = entry_token(booking)
    services.rotate_qr_nonce(booking)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, token=old)

    assert code_of(exc) == "qr_outdated"
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


def test_spent_nonce_on_a_confirmed_booking_is_already_used(gate):
    booking = book(gate, qr_nonce_used_at=gate.now)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "already_used"
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


def test_redis_spent_marker_means_already_used(gate, fake_redis):
    booking = book(gate)
    claims = qr.verify_token(entry_token(booking), now=gate.now)
    fake_redis.set(f"habi:qr:used:{claims.booking_id}:{claims.nonce}", "1")

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "already_used"


# --- lot and operator -------------------------------------------------------------------------


def test_qr_of_another_lot_is_wrong_lot(gate):
    other = make_world(slots=1)
    other_driver = make_user("DRIVER")
    booking = make_booking(
        user=other_driver,
        slot=other.slots[0],
        vehicle=make_vehicle(other_driver),
        start=gate.now - timedelta(minutes=5),
        end=gate.now + timedelta(hours=2),
        status=S.CONFIRMED,
    )

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)  # our operator is not assigned to the other lot

    assert code_of(exc) == "wrong_lot"
    assert exc.value.status_code == 409
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


def test_operator_of_both_lots_scanning_in_the_wrong_one_gets_wrong_lot(gate):
    other = make_world(slots=1)
    OperatorAssignment.objects.create(operator=gate.operator, parking_lot=other.lot)
    booking = book(gate)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, expected_lot_id=other.lot.id)

    assert code_of(exc) == "wrong_lot"
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


def test_expected_lot_that_the_operator_does_not_serve_looks_like_wrong_lot(gate):
    other = make_world(slots=1)
    booking = book(gate)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, expected_lot_id=other.lot.id)

    assert code_of(exc) == "wrong_lot"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda g: OperatorAssignment.objects.filter(operator=g.operator).update(revoked_at=g.now),
        lambda g: User.objects.filter(pk=g.operator.pk).update(is_active=False),
        lambda g: User.objects.filter(pk=g.operator.pk).update(role=User.Role.DRIVER),
        lambda g: ParkingLot.objects.filter(pk=g.lot.pk).update(status=LotStatus.SUSPENDED),
    ],
    ids=["revoked", "inactive", "demoted", "lot_suspended"],
)
def test_lost_access_looks_exactly_like_a_foreign_lot(gate, mutate):
    booking = book(gate)
    token = entry_token(booking)
    mutate(gate)
    operator = User.objects.get(pk=gate.operator.pk)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, operator=operator, token=token)

    assert code_of(exc) == "wrong_lot"
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


def test_foreign_owner_and_driver_are_wrong_lot(gate):
    booking = book(gate)

    for stranger in (make_user("OWNER"), make_user("DRIVER")):
        with pytest.raises(ApiError) as exc:
            scan(gate, booking, operator=stranger)
        assert code_of(exc) == "wrong_lot"


def test_signed_token_of_a_booking_that_does_not_exist_is_qr_invalid(gate):
    import uuid

    ghost = qr.signing.dumps(
        {
            "b": str(uuid.uuid4()),
            "l": str(gate.lot.id),
            "n": "n" * 22,
            "nb": int((gate.now - timedelta(hours=1)).timestamp()),
            "e": int((gate.now + timedelta(hours=1)).timestamp()),
        },
        key=qr._key(),
        salt=qr.SALT,
        compress=True,
    )

    with pytest.raises(ApiError) as exc:
        checkin.check_in(operator=gate.operator, token=ghost, now=gate.now)

    assert code_of(exc) == "qr_invalid"


def test_operator_cannot_check_in_their_own_booking(gate):
    booking = make_booking(
        user=gate.operator,
        slot=gate.slot,
        vehicle=make_vehicle(gate.operator),
        start=gate.now - timedelta(minutes=5),
        end=gate.now + timedelta(hours=2),
        status=S.CONFIRMED,
    )

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "self_service_forbidden"
    assert exc.value.status_code == 403


# --- physical slot ----------------------------------------------------------------------------


def test_slot_still_taken_by_someone_else_is_slot_occupied(gate):
    booking = book(gate)
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OCCUPIED)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "slot_occupied"
    after = Booking.objects.get(pk=booking.pk)
    assert (after.status, after.qr_nonce_used_at) == (S.CONFIRMED, None)  # nonce NOT burnt


def test_slot_out_of_service_is_refused(gate):
    booking = book(gate)
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.OUT_OF_SERVICE)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "slot_out_of_service"


def test_reserved_slot_of_this_booking_is_accepted(gate):
    booking = book(gate)
    Slot.objects.filter(pk=gate.slot.pk).update(status=SlotStatus.RESERVED)

    assert scan(gate, booking).code == "checked_in"


# --- atomicity and locks ----------------------------------------------------------------------


def test_failure_after_the_nonce_was_spent_rolls_everything_back(gate, monkeypatch):
    booking = book(gate)
    seen = {}

    def boom(*args, **kwargs):
        seen["spent_inside"] = Booking.objects.get(pk=booking.pk).qr_nonce_used_at
        raise RuntimeError("database went away")

    monkeypatch.setattr("apps.bookings.checkin.operations.set_slot_status_locked", boom)

    with pytest.raises(RuntimeError):
        scan(gate, booking)

    after = Booking.objects.get(pk=booking.pk)
    assert seen["spent_inside"] is not None  # it WAS spent inside the transaction ...
    assert (after.status, after.qr_nonce_used_at, after.checked_in_at) == (S.CONFIRMED, None, None)
    assert BookingEvent.objects.filter(booking=booking, to_status=S.ACTIVE).count() == 0


def test_the_redis_marker_is_written_only_after_commit(
    gate, fake_redis, django_capture_on_commit_callbacks
):
    booking = book(gate)
    claims = qr.verify_token(entry_token(booking), now=gate.now)
    key = f"habi:qr:used:{claims.booking_id}:{claims.nonce}"

    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        scan(gate, booking)

    assert fake_redis.get(key) is None  # nothing before the commit
    for callback in callbacks:
        callback()
    assert fake_redis.get(key) == "1"


def test_check_in_works_when_redis_is_down(gate, monkeypatch, django_capture_on_commit_callbacks):
    booking = book(gate)

    def down():
        raise RedisConnectionError("redis is down")

    monkeypatch.setattr(qr, "get_redis", down)

    with django_capture_on_commit_callbacks(execute=True):
        result = scan(gate, booking)

    assert result.code == "checked_in"
    assert Booking.objects.get(pk=booking.pk).status == S.ACTIVE


def test_lock_order_is_lot_then_booking_then_slot(gate, monkeypatch):
    booking = book(gate)
    order = []
    original = QuerySet.select_for_update

    def spy(self, *args, **kwargs):
        order.append(self.model.__name__)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(QuerySet, "select_for_update", spy)

    scan(gate, booking)

    assert order[0] == "ParkingLot"
    assert order.index("Booking") < order.index("Slot")
    assert order.count("ParkingLot") >= 1


# --- audit ------------------------------------------------------------------------------------


def test_every_attempt_is_audited_with_its_outcome_and_never_the_token(
    gate, caplog, django_capture_on_commit_callbacks
):
    booking = book(gate)
    good = entry_token(booking)
    bad = "forged." + good[:40]

    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        scan(gate, booking, token=good)
        with pytest.raises(ApiError):
            scan(gate, booking, token=bad)

    scans = [r for r in caplog.records if r.getMessage() == "audit operator.checkin"]
    outcomes = [r.audit_after["outcome"] for r in scans]
    assert outcomes == ["checked_in", "qr_invalid"]
    assert all(r.audit_actor == str(gate.operator.id) for r in scans)
    everything = " ".join(
        f"{r.getMessage()} {getattr(r, 'audit_before', '')} {getattr(r, 'audit_after', '')}"
        for r in caplog.records
    )
    assert good not in everything
    assert bad not in everything
    assert str(scans[0].audit_after["booking"]) == str(booking.id)


def test_rejected_attempt_audit_survives_the_rolled_back_transaction(
    gate, caplog, django_capture_on_commit_callbacks
):
    booking = book(gate, status=S.CANCELLED)

    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
        pytest.raises(ApiError),
    ):
        scan(gate, booking)

    record = next(r for r in caplog.records if r.getMessage() == "audit operator.checkin")
    assert record.audit_after["outcome"] == "booking_cancelled"
    assert record.audit_after["lot"] == str(gate.lot.id)


def test_lot_in_audit_is_taken_from_the_booking_not_the_token(gate):
    other_lot = make_lot(make_user("OWNER"), "Elsewhere", status=LotStatus.ACTIVE)
    booking = book(gate)
    # a token claiming another lot for this booking, signed properly, must be a mismatch
    token = entry_token(booking)
    claims = qr.verify_token(token, now=gate.now)
    forged = qr.signing.dumps(
        {
            "b": str(claims.booking_id),
            "l": str(other_lot.id),
            "n": claims.nonce,
            "nb": int(claims.not_before.timestamp()),
            "e": int(claims.expires_at.timestamp()),
        },
        key=qr._key(),
        salt=qr.SALT,
        compress=True,
    )

    with pytest.raises(ApiError) as exc:
        scan(gate, booking, token=forged)

    assert code_of(exc) == "wrong_lot"  # claims do not match the booking's real lot
    assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED


def test_make_gate_factory_builds_independent_gates():
    first, second = make_gate(), make_gate()
    assert first.lot.id != second.lot.id


# --- plate required by the lot, audit failures, lazy sweeps ---------------------------------------


def test_a_lot_that_requires_the_plate_refuses_a_scan_without_it(gate):
    from apps.parking.models import ParkingLot

    ParkingLot.objects.filter(pk=gate.lot.pk).update(require_plate_on_checkin=True)
    booking = book(gate, vehicle=make_vehicle(gate.driver, plate="01A123BC"))

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)
    assert (exc.value.status_code, code_of(exc)) == (422, "plate_required")
    assert Booking.objects.get(pk=booking.pk).qr_nonce_used_at is None  # nothing spent

    assert scan(gate, booking, plate_number="01A123BC").code == "checked_in"


def test_the_plate_requirement_is_off_by_default_and_owner_settable(gate):
    from tests.helpers import client_for

    assert gate.lot.require_plate_on_checkin is False
    response = client_for(gate.owner).patch(
        f"/api/v1/admin/parkings/{gate.lot.id}", {"require_plate_on_checkin": True}, format="json"
    )

    assert response.status_code == 200
    assert response.json()["require_plate_on_checkin"] is True


def test_a_broken_audit_table_does_not_turn_a_success_into_a_500(gate, monkeypatch, caplog):
    def broken(**_kwargs):
        raise RuntimeError("audit table is down")

    monkeypatch.setattr("apps.bookings.operations.audit", broken)
    booking = book(gate)

    with caplog.at_level(logging.ERROR):
        result = scan(gate, booking)

    assert result.code == "checked_in"
    assert Booking.objects.get(pk=booking.pk).status == S.ACTIVE
    assert "could not audit" in caplog.text


def test_a_broken_audit_table_does_not_replace_the_real_refusal(gate, monkeypatch):
    def broken(**_kwargs):
        raise RuntimeError("audit table is down")

    monkeypatch.setattr("apps.bookings.operations.audit", broken)
    booking = book(gate, status=S.CANCELLED)

    with pytest.raises(ApiError) as exc:
        scan(gate, booking)

    assert code_of(exc) == "booking_cancelled"  # not a RuntimeError


def test_a_broken_audit_inside_a_transaction_does_not_poison_it(gate, monkeypatch):
    from django.db import transaction

    monkeypatch.setattr("apps.bookings.operations.audit", lambda **_k: 1 / 0)
    booking = book(gate)

    with transaction.atomic():
        scan(gate, booking)
        assert Booking.objects.filter(pk=booking.pk).exists()  # the connection is still usable


def test_the_sweeps_are_reachable_from_services_and_either_module_imports_first():
    from apps.bookings import services as services_module
    from apps.bookings import sweeps

    for name in ("expire_hold", "expire_overdue_holds", "mark_no_shows", "detect_overstays"):
        assert getattr(services_module, name) is getattr(sweeps, name)
    with pytest.raises(AttributeError):
        services_module.no_such_sweep  # noqa: B018
    import inspect

    source = inspect.getsource(services_module)
    assert "from .sweeps import" not in source  # no import-time dependency on sweeps
