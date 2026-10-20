"""DELETE /api/v1/me: anonymise, sign out, keep the books."""

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts import services
from apps.accounts.models import Device, User
from apps.audit.models import AuditLog
from apps.bookings.models import Booking
from tests.adminops.conftest import bearer
from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user

pytestmark = pytest.mark.django_db
URL = "/api/v1/me"


@pytest.fixture
def person():
    user = make_user(
        "DRIVER",
        first_name="Dilya",
        last_name="K",
        telegram_username="dilya",
        phone="+998901112233",
    )
    Device.objects.create(user=user, platform="android", expo_push_token="ExponentPushToken[abc]")
    return user


def booking_for(user, status, hours=(2, 4)):
    world = make_world(slots=1)
    now = timezone.now()
    return make_booking(
        user=user,
        slot=world.slots[0],
        vehicle=make_vehicle(user),
        status=status,
        start=now + timedelta(hours=hours[0]),
        end=now + timedelta(hours=hours[1]),
    )


def test_deleting_anonymises_signs_out_and_audits(person):
    telegram_id = person.telegram_id
    refresh = RefreshToken.for_user(person)
    client = bearer(person)
    response = client.delete(URL)
    assert response.status_code == 204
    person.refresh_from_db()
    assert (person.first_name, person.last_name, person.telegram_username) == ("", "", "")
    assert person.phone is None and not person.is_active and not person.has_usable_password()
    assert person.telegram_id < 0 and person.telegram_id != telegram_id
    assert not Device.objects.filter(user=person).exists()
    assert BlacklistedToken.objects.filter(token__jti=refresh["jti"]).exists()
    row = AuditLog.objects.get(action="user.self_deleted")
    assert row.actor_id == person.pk and row.target_id == str(person.pk)
    assert "Dilya" not in str(row.meta) and "998" not in str(row.meta)
    assert client.get(URL).status_code == 401  # the old access token is dead at once


def test_the_same_telegram_id_can_sign_up_again_as_a_new_account(person):
    telegram_id = person.telegram_id
    assert bearer(person).delete(URL).status_code == 204
    result = services.login_with_telegram(
        telegram_id=telegram_id,
        phone="+998901112233",
        username="dilya",
        first_name="D",
        last_name="",
    )
    assert result.is_new and result.user.pk != person.pk and result.user.is_active


@pytest.mark.parametrize("status", ["PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "OVERSTAY"])
def test_live_bookings_block_deletion(person, status):
    booking_for(person, status, hours=(-1, 1) if status in ("ACTIVE", "OVERSTAY") else (2, 4))
    response = bearer(person).delete(URL)
    assert response.status_code == 409 and response.data["code"] == "account_deletion_blocked"
    person.refresh_from_db()
    assert person.is_active and person.first_name == "Dilya"
    assert not AuditLog.objects.filter(action="user.self_deleted").exists()


def test_finished_bookings_stay_for_accounting(person):
    booking = booking_for(person, "COMPLETED", hours=(-5, -3))
    assert bearer(person).delete(URL).status_code == 204
    kept = Booking.objects.get(pk=booking.pk)
    assert kept.user_id == person.pk and kept.vehicle_plate


def test_owner_with_lots_is_blocked():
    owner = make_world(slots=1).owner
    assert bearer(owner).delete(URL).status_code == 409


def test_the_last_admin_is_blocked_but_not_when_another_exists():
    first = make_user("ADMIN")
    assert bearer(first).delete(URL).data["code"] == "account_deletion_blocked"
    make_user("ADMIN")
    assert bearer(first).delete(URL).status_code == 204


def test_operator_assignments_end(person):
    from apps.operators import services as operator_services
    from apps.parking.models import OperatorAssignment

    world = make_world(slots=1)
    _invite, code = operator_services.create_invite(lot=world.lot, actor=world.owner, hours=1)
    operator_services.accept_invite(user=person, code=code)
    assert bearer(person).delete(URL).status_code == 204
    assert not OperatorAssignment.objects.filter(operator=person, revoked_at__isnull=True).exists()


def test_anonymous_is_401(person):
    assert APIClient().delete(URL).status_code == 401


def test_the_call_is_throttled(monkeypatch):
    from rest_framework.throttling import SimpleRateThrottle

    rates = {**SimpleRateThrottle.THROTTLE_RATES, "account_delete": "1/hour"}
    monkeypatch.setattr(SimpleRateThrottle, "THROTTLE_RATES", rates)
    client = bearer(make_world(slots=1).owner)  # blocked by its lot: every call is a 409
    assert [client.delete(URL).status_code for _ in range(2)] == [409, 429]


def test_tombstones_are_unique(person):
    other = make_user("DRIVER")
    bearer(person).delete(URL)
    bearer(other).delete(URL)
    ids = list(User.objects.filter(telegram_id__lt=0).values_list("telegram_id", flat=True))
    assert len(ids) == len(set(ids)) == 2
