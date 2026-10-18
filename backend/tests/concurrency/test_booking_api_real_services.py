"""POST /bookings end to end on REAL PostgreSQL + REAL Redis (idempotency store included).

Skipped locally; in CI both REQUIRE_POSTGIS=1 and REQUIRE_REDIS=1 apply.
"""

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.bookings import services
from apps.bookings.models import Booking
from tests.bookings.factories import make_vehicle, make_world
from tests.helpers import client_for, make_user
from tests.operators.parallel import run_parallel

pytestmark = [
    pytest.mark.postgis,
    pytest.mark.redis,
    pytest.mark.django_db(transaction=True),
    pytest.mark.usefixtures("generous_throttles"),
]

PARALLEL = 50
DUPLICATES = 3


def window():
    start = timezone.now().replace(second=0, microsecond=0) + timedelta(hours=2)
    return start, start + timedelta(hours=1)


def payload(world, vehicle, start, end):
    return {
        "parking_lot_id": str(world.lot.pk),
        "slot_type": "STANDARD",
        "vehicle_id": str(vehicle.pk),
        "start": start.isoformat(),
        "end": end.isoformat(),
    }


def post(user, body, key):
    return client_for(user).post("/api/v1/bookings", body, format="json", HTTP_IDEMPOTENCY_KEY=key)


def test_many_users_with_duplicate_taps_one_slot_one_booking():
    start, end = window()
    world = make_world(slots=1)
    jobs, owners = [], []
    for n in range(PARALLEL):
        user = make_user("DRIVER")
        body = payload(world, make_vehicle(user), start, end)
        for _copy in range(DUPLICATES):  # a double / triple tap per user: same key, same body
            jobs.append(lambda u=user, b=body, k=f"api-race-{n:03d}-{user.pk}": post(u, b, k))
            owners.append(n)
    results = run_parallel(jobs)
    assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
    codes = [res.status_code for _ok, res in results]
    assert codes.count(201) == 1, codes
    assert Booking.objects.count() == 1
    # every other answer is a loss (409 no slot / still in progress) or a replay of the winner
    assert set(codes) <= {201, 200, 409}, codes
    for _ok, res in results:
        if res.status_code == 409:
            assert str(res.json()["code"]) in ("no_slot_available", "idempotency_in_progress")


def test_one_key_fifty_parallel_requests_replay_the_single_booking(settings):
    settings.BOOKING_IDEMPOTENCY_WAIT_SECONDS = 30  # duplicates wait for the first, never 409
    start, end = window()
    world = make_world(slots=3)
    user = make_user("DRIVER")
    body = payload(world, make_vehicle(user), start, end)
    results = run_parallel(
        [lambda: post(user, body, "one-key-for-all-requests") for _ in range(PARALLEL)]
    )
    assert all(ok for ok, _ in results), [r for ok, r in results if not ok]
    codes = sorted(res.status_code for _ok, res in results)
    assert codes == [200] * (PARALLEL - 1) + [201], codes
    ids = {res.json()["id"] for _ok, res in results}
    assert len(ids) == 1
    for _ok, res in results:
        if res.status_code == 200:
            assert res.get("Idempotent-Replayed") == "true"
    assert Booking.objects.count() == 1


def test_a_failed_attempt_releases_the_key_so_a_retry_can_succeed():
    start, end = window()
    world = make_world(slots=1)
    holder = make_user("DRIVER")
    taker = make_user("DRIVER")
    key = "retry-after-loss-0001"
    assert (
        post(
            holder, payload(world, make_vehicle(holder), start, end), "first-takes-it-01"
        ).status_code
        == 201
    )
    vehicle = make_vehicle(taker)
    lost = post(taker, payload(world, vehicle, start, end), key)
    assert lost.status_code == 409 and str(lost.json()["code"]) == "no_slot_available"
    # the loser's key was released: after the slot frees up the SAME key books it
    booking = Booking.objects.get()
    services.cancel_booking(booking_id=booking.pk, user=holder)
    retried = post(taker, payload(world, vehicle, start, end), key)
    assert retried.status_code == 201, retried.content
