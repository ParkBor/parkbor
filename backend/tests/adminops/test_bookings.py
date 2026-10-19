import uuid
from datetime import timedelta

import pytest

from apps.audit.models import AuditLog
from apps.bookings.models import Booking, BookingEvent
from apps.payments.models import Payment, Refund
from tests.adminops.conftest import BASE, bearer
from tests.bookings.factories import make_vehicle
from tests.payments.factories import make_payment, make_refund

pytestmark = pytest.mark.django_db


def listing(user, **params):
    response = bearer(user).get(f"{BASE}/bookings", params)
    assert response.status_code == 200, response.data
    return response.data["results"]


def test_row_shape_matches_the_ui_contract(admin, world_a, make_bk):
    booking = make_bk(world_a)
    (row,) = listing(admin)
    assert set(row) == {
        "id", "status", "kind", "plate_number", "slot", "parking_lot", "start", "end", "amount",
        "paid_amount", "refund_amount", "refund_status", "payment_provider", "checked_in_at",
        "checked_out_at", "cancelled_at", "overstay_minutes", "overstay_amount",
        "overstay_status", "overstay_needs_review", "created_at",
    }  # fmt: skip
    assert row["id"] == str(booking.pk) and row["amount"] == "12000.00"
    assert set(row["slot"]) == {"id", "code", "zone", "floor", "type"}
    assert row["parking_lot"] == {"id": str(world_a.lot.pk), "name": world_a.lot.name}
    assert row["refund_status"] == "none" and row["start"].endswith("+05:00")


def test_owner_sees_only_own_lots_and_foreign_detail_is_404(owner_a, world_a, world_b, make_bk):
    mine, theirs = make_bk(world_a), make_bk(world_b)
    assert [r["id"] for r in listing(owner_a)] == [str(mine.pk)]
    assert bearer(owner_a).get(f"{BASE}/bookings/{theirs.pk}").status_code == 404
    assert bearer(owner_a).get(f"{BASE}/bookings/{mine.pk}").status_code == 200
    assert bearer(owner_a).post(f"{BASE}/bookings/{theirs.pk}/cancel", {}).status_code == 404


def test_filters(admin, world_a, world_b, make_bk):
    confirmed = make_bk(world_a, slot=0)
    active = make_bk(world_a, slot=1, status="ACTIVE", hours=(-1, 1))
    other_lot = make_bk(world_b, status="COMPLETED", hours=(-5, -3))
    ids = lambda **p: {r["id"] for r in listing(admin, **p)}  # noqa: E731
    assert ids(status="ACTIVE") == {str(active.pk)}
    assert ids(parking_lot=str(world_b.lot.pk)) == {str(other_lot.pk)}
    assert ids(kind="WALK_IN") == set()
    assert ids(kind="ONLINE") == {str(b.pk) for b in (confirmed, active, other_lot)}
    window = {"from": (confirmed.starts_at - timedelta(minutes=1)).isoformat(),
              "to": (confirmed.starts_at + timedelta(minutes=1)).isoformat()}  # fmt: skip
    assert ids(**window) == {str(confirmed.pk)}


def test_plate_search_ignores_case_spaces_and_dashes(admin, world_a, make_bk, driver):
    vehicle = make_vehicle(driver, plate="01A123BC")
    booking = make_bk(world_a, vehicle=vehicle)
    make_bk(world_a, slot=1, hours=(6, 8))
    for term in ("01a123bc", "01 A-123 bc", "123"):
        assert [r["id"] for r in listing(admin, search=term)] == [str(booking.pk)]


def test_overstay_due_filter(admin, world_a, make_bk):
    due = make_bk(
        world_a, status="OVERSTAY", hours=(-3, -1), overstay_status="due",
        overstay_amount="3000", overstay_minutes=20, paid_amount="12000",
    )  # fmt: skip
    make_bk(world_a, slot=1, status="COMPLETED", hours=(-9, -7))
    assert [r["id"] for r in listing(admin, overstay_status="due")] == [str(due.pk)]


def test_invalid_filter_values_are_400(admin):
    client = bearer(admin)
    assert client.get(f"{BASE}/bookings", {"status": "NOPE"}).status_code == 400
    assert client.get(f"{BASE}/bookings", {"parking_lot": str(uuid.uuid4())}).status_code == 400


def test_ordering_is_stable_and_whitelisted(admin, world_a, make_bk):
    for index in range(3):
        make_bk(
            world_a,
            slot=index,
            hours=(2 + index * 3, 4 + index * 3),
            amount=str(1000 * (index + 1)),
        )
    amounts = [r["amount"] for r in listing(admin, ordering="-amount")]
    assert amounts == ["3000.00", "2000.00", "1000.00"]
    assert len(listing(admin, ordering="user__password")) == 3  # unknown key ignored, not an error


def test_list_has_no_n_plus_one(admin, world_a, make_bk, django_assert_max_num_queries):
    for index in range(3):
        booking = make_bk(world_a, slot=index, hours=(2 + index * 3, 4 + index * 3))
        make_refund(make_payment(booking, status="PAID"), amount="1000", status="MANUAL")
    with django_assert_max_num_queries(5):
        assert len(listing(admin)) == 3
    for index in range(3):
        make_bk(world_a, slot=index, hours=(20 + index * 3, 22 + index * 3))
    with django_assert_max_num_queries(5):
        assert len(listing(admin)) == 6


def test_detail_includes_events_payments_and_refunds(admin, world_a, make_bk):
    booking = make_bk(world_a)
    BookingEvent.objects.create(booking=booking, to_status="CONFIRMED", reason="paid", actor=admin)
    payment = make_payment(booking, status="PAID", amount="12000")
    refund = make_refund(payment, amount="6000", status="MANUAL", last_error="no_paid_payment")
    data = bearer(admin).get(f"{BASE}/bookings/{booking.pk}").data
    assert [e["reason"] for e in data["events"]] == ["paid"]
    assert data["events"][0]["actor"] == "admin"  # a role label, never a user id
    assert data["payments"][0]["id"] == str(payment.pk)
    assert data["refunds"][0]["id"] == str(refund.pk) and data["refund_status"] == "manual"
    assert "external_id" not in data["payments"][0] and "raw_state" not in data["payments"][0]


def test_cancel_confirmed_refunds_everything_paid_and_is_audited(admin, world_a, make_bk, now):
    booking = make_bk(world_a, hours=(0.2, 2))  # inside the policy's "late" window
    make_payment(booking, status="PAID", amount="12000", refunded_amount="0")
    response = bearer(admin).post(
        f"{BASE}/bookings/{booking.pk}/cancel", {"reason": "lot flooded"}, format="json"
    )
    assert response.status_code == 200
    assert response.data["status"] == "CANCELLED" and response.data["refund_amount"] == "12000.00"
    refund = Refund.objects.get(booking=booking)
    assert refund.amount == 12000 and refund.status == "PENDING"
    assert Payment.objects.get(booking=booking).refunded_amount == 12000
    event = BookingEvent.objects.get(booking=booking, reason="admin_cancelled")
    assert event.actor_id == admin.pk and event.meta["note"] == "lot flooded"
    assert AuditLog.objects.filter(action="booking.admin_cancel", actor=admin).count() == 1


def test_cancel_is_idempotent_and_makes_one_refund(admin, world_a, make_bk):
    booking = make_bk(world_a)
    make_payment(booking, status="PAID", amount="12000")
    client = bearer(admin)
    first = client.post(f"{BASE}/bookings/{booking.pk}/cancel", {}, format="json")
    second = client.post(f"{BASE}/bookings/{booking.pk}/cancel", {}, format="json")
    assert first.status_code == second.status_code == 200
    assert Refund.objects.filter(booking=booking).count() == 1
    assert BookingEvent.objects.filter(booking=booking, reason="admin_cancelled").count() == 1


def test_cancel_pending_payment_has_no_refund(admin, world_a, make_bk, now):
    booking = make_bk(world_a, status="PENDING_PAYMENT", hold_expires_at=now + timedelta(minutes=5))
    response = bearer(admin).post(f"{BASE}/bookings/{booking.pk}/cancel", {}, format="json")
    assert response.status_code == 200 and response.data["refund_amount"] == "0.00"
    assert not Refund.objects.exists()


@pytest.mark.parametrize("status", ["ACTIVE", "COMPLETED", "NO_SHOW", "EXPIRED"])
def test_cancel_refuses_other_states(admin, world_a, make_bk, status):
    booking = make_bk(world_a, status=status, hours=(-1, 1))
    response = bearer(admin).post(f"{BASE}/bookings/{booking.pk}/cancel", {}, format="json")
    assert response.status_code == 409 and response.data["code"] == "invalid_transition"
    assert Booking.objects.get(pk=booking.pk).status == status


def test_owner_cancels_own_lot_booking(owner_a, world_a, make_bk):
    booking = make_bk(world_a)
    response = bearer(owner_a).post(f"{BASE}/bookings/{booking.pk}/cancel", {}, format="json")
    assert response.status_code == 200


def test_service_refuses_a_foreign_owner_even_if_the_view_is_bypassed(owner_b, world_a, make_bk):
    from apps.bookings import services
    from apps.core.exceptions import NotFoundError

    booking = make_bk(world_a)
    with pytest.raises(NotFoundError):
        services.admin_cancel_booking(booking_id=booking.pk, actor=owner_b)


@pytest.mark.parametrize(
    "reason", ["call me +998 90 123 45 67", "card 8600 1234 5678 9012", "x" * 201]
)
def test_cancel_reason_is_sanitised(admin, world_a, make_bk, reason):
    booking = make_bk(world_a)
    response = bearer(admin).post(
        f"{BASE}/bookings/{booking.pk}/cancel", {"reason": reason}, format="json"
    )
    assert response.status_code == 400
    assert Booking.objects.get(pk=booking.pk).status == "CONFIRMED"


def test_cancel_rejects_unknown_fields(admin, world_a, make_bk):
    booking = make_bk(world_a)
    response = bearer(admin).post(
        f"{BASE}/bookings/{booking.pk}/cancel", {"status": "COMPLETED"}, format="json"
    )
    assert response.status_code == 400


def test_to_is_exclusive_and_from_inclusive(admin, world_a, make_bk):
    booking = make_bk(world_a)
    edge = booking.starts_at.isoformat()
    assert [r["id"] for r in listing(admin, **{"from": edge})] == [str(booking.pk)]
    assert listing(admin, **{"to": edge}) == []
