import pytest
from django.db import IntegrityError, transaction

from apps.audit.models import AuditLog
from apps.parking.models import ParkingLot
from apps.reviews.models import Review
from tests.adminops.conftest import BASE, bearer
from tests.auth_fixtures import clear_throttle_cache, fake_redis  # noqa: F401
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user

pytestmark = pytest.mark.django_db


@pytest.fixture
def world(db):
    return make_world(slots=3)


@pytest.fixture
def driver(db):
    return make_user("DRIVER", first_name="Secret", last_name="Person", phone="+998901234567")


def completed(world, driver, now, slot=0, status="COMPLETED"):
    from datetime import timedelta

    return make_booking(
        user=driver, slot=world.slots[slot], vehicle=make_vehicle(driver),
        start=now - timedelta(hours=4 - slot), end=now - timedelta(hours=3 - slot),
        status=status, amount="6000",
    )  # fmt: skip


@pytest.fixture
def now():
    from django.utils import timezone

    return timezone.now().replace(microsecond=0)


def post(user, world, booking, rating=5, comment="great"):
    body = {"booking_id": str(booking.pk), "rating": rating, "comment": comment}
    return bearer(user).post(f"/api/v1/parkings/{world.lot.pk}/reviews", body, format="json")


def rating_of(world):
    return ParkingLot.objects.get(pk=world.lot.pk).rating


def test_driver_reviews_a_completed_booking_and_the_rating_follows(world, driver, now):
    response = post(driver, world, completed(world, driver, now), rating=4, comment="ok")
    assert response.status_code == 201
    assert set(response.data) == {"id", "rating", "comment", "created_at"}
    assert rating_of(world) == 4.0


def test_rating_is_the_average_of_published_reviews(world, driver, now):
    other = make_user("DRIVER")
    post(driver, world, completed(world, driver, now, 0), rating=5)
    post(other, world, completed(world, other, now, 1), rating=2)
    assert rating_of(world) == 3.5
    post(driver, world, completed(world, driver, now, 2), rating=2)
    assert rating_of(world) == 3.0


@pytest.mark.parametrize("rating", [0, 6, -1, "x", None])
def test_rating_must_be_1_to_5(world, driver, now, rating):
    assert post(driver, world, completed(world, driver, now), rating=rating).status_code == 400
    assert not Review.objects.exists()


def test_comment_is_optional_and_length_limited(world, driver, now):
    booking = completed(world, driver, now)
    assert post(driver, world, booking, comment="x" * 1001).status_code == 400
    assert post(driver, world, booking, comment="").status_code == 201


def test_one_review_per_booking(world, driver, now):
    booking = completed(world, driver, now)
    assert post(driver, world, booking).status_code == 201
    second = post(driver, world, booking)
    assert second.status_code == 409 and second.data["code"] == "already_reviewed"
    assert Review.objects.count() == 1


@pytest.mark.parametrize("status", ["CONFIRMED", "ACTIVE", "CANCELLED", "NO_SHOW"])
def test_only_completed_bookings_can_be_reviewed(world, driver, now, status):
    response = post(driver, world, completed(world, driver, now, status=status))
    assert response.status_code == 409 and response.data["code"] == "booking_not_reviewable"


def test_someone_elses_booking_or_another_lot_is_404(world, driver, now):
    stranger = make_user("DRIVER")
    booking = completed(world, driver, now)
    assert post(stranger, world, booking).status_code == 404
    other_world = make_world(slots=1)
    assert post(driver, other_world, booking).status_code == 404


def test_anonymous_cannot_post_or_list(world):
    from rest_framework.test import APIClient

    url = f"/api/v1/parkings/{world.lot.pk}/reviews"
    assert APIClient().post(url, {}).status_code == 401
    assert APIClient().get(url).status_code == 401


def test_public_list_has_published_only_and_no_author(world, driver, now):
    visible = post(driver, world, completed(world, driver, now, 0), comment="visible").data
    hidden_booking = completed(world, driver, now, 1)
    hidden = post(driver, world, hidden_booking, comment="hidden").data
    Review.objects.filter(pk=hidden["id"]).update(status="HIDDEN")
    response = bearer(driver).get(f"/api/v1/parkings/{world.lot.pk}/reviews")
    assert [r["id"] for r in response.data["results"]] == [visible["id"]]
    assert set(response.data["results"][0]) == {"id", "rating", "comment", "created_at"}
    assert bearer(driver).get(f"/api/v1/parkings/{make_world().lot.pk}/reviews").data["count"] == 0
    import uuid

    assert bearer(driver).get(f"/api/v1/parkings/{uuid.uuid4()}/reviews").status_code == 404


def test_post_is_throttled(world, driver, now, monkeypatch):
    from rest_framework.throttling import SimpleRateThrottle

    monkeypatch.setattr(
        SimpleRateThrottle,
        "THROTTLE_RATES",
        {**SimpleRateThrottle.THROTTLE_RATES, "review_write": "1/hour"},
    )
    assert post(driver, world, completed(world, driver, now, 0)).status_code == 201
    assert post(driver, world, completed(world, driver, now, 1)).status_code == 429


def test_database_constraints(world, driver, now):
    booking = completed(world, driver, now)
    with pytest.raises(IntegrityError), transaction.atomic():
        Review.objects.create(parking_lot=world.lot, user=driver, booking=booking, rating=9)


# --- moderation ----------------------------------------------------------------------------------


@pytest.fixture
def review(world, driver, now):
    post(driver, world, completed(world, driver, now), rating=1, comment="bad")
    return Review.objects.get()


def test_hide_and_publish_update_the_rating_and_audit(world, review):
    admin = make_user("ADMIN")
    client = bearer(admin)
    hidden = client.post(f"{BASE}/reviews/{review.pk}/hide")
    assert hidden.status_code == 200 and hidden.data["status"] == "HIDDEN"
    assert rating_of(world) == 0.0
    again = client.post(f"{BASE}/reviews/{review.pk}/hide")
    assert again.status_code == 200
    assert AuditLog.objects.filter(action="review.hide", actor=admin).count() == 1
    published = client.post(f"{BASE}/reviews/{review.pk}/publish")
    assert published.data["status"] == "PUBLISHED" and rating_of(world) == 1.0
    assert AuditLog.objects.filter(action="review.publish").count() == 1


def test_admin_list_shape_filters_and_no_author(world, review):
    admin = make_user("ADMIN")
    response = bearer(admin).get(f"{BASE}/reviews")
    (row,) = response.data["results"]
    assert set(row) == {"id", "parking_lot", "rating", "comment", "status", "created_at"}
    assert row["parking_lot"]["name"] == world.lot.name
    client = bearer(admin)
    assert client.get(f"{BASE}/reviews", {"status": "HIDDEN"}).data["count"] == 0
    assert client.get(f"{BASE}/reviews", {"rating": 1}).data["count"] == 1
    assert client.get(f"{BASE}/reviews", {"parking_lot": str(world.lot.pk)}).data["count"] == 1


def test_owner_reads_only_own_lot_reviews_and_cannot_moderate(world, review):
    other = make_world(slots=1)
    assert bearer(world.owner).get(f"{BASE}/reviews").data["count"] == 1
    assert bearer(other.owner).get(f"{BASE}/reviews").data["count"] == 0
    assert (
        bearer(other.owner).get(f"{BASE}/reviews", {"parking_lot": str(world.lot.pk)}).status_code
        == 400
    )
    assert bearer(world.owner).post(f"{BASE}/reviews/{review.pk}/hide").status_code == 403


def test_moderating_an_unknown_review_is_404():
    import uuid

    admin = make_user("ADMIN")
    assert bearer(admin).post(f"{BASE}/reviews/{uuid.uuid4()}/hide").status_code == 404


def test_unpaid_completed_bookings_cannot_be_reviewed(world, driver, now):
    booking = completed(world, driver, now)
    type(booking).objects.filter(pk=booking.pk).update(paid_amount=0)
    response = post(driver, world, booking)
    assert response.status_code == 409 and response.data["code"] == "booking_not_reviewable"


@pytest.mark.parametrize("status", ["SUSPENDED", "PENDING_REVIEW"])
def test_reviews_exist_only_for_active_lots(world, driver, now, status):
    booking = completed(world, driver, now)
    ParkingLot.objects.filter(pk=world.lot.pk).update(status=status)
    assert post(driver, world, booking).status_code == 404
    assert bearer(driver).get(f"/api/v1/parkings/{world.lot.pk}/reviews").status_code == 404
    assert not Review.objects.exists()
