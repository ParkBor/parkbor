from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from apps.adminpanel import stats
from apps.bookings.models import Booking
from apps.parking.models import ParkingLot, Slot
from tests.adminops.conftest import BASE, bearer
from tests.payments.factories import make_payment, make_refund

pytestmark = pytest.mark.django_db

TZ = ZoneInfo("Asia/Tashkent")


def get(user, path, **params):
    return bearer(user).get(f"{BASE}/stats/{path}", params)


def pay(booking, amount, when, refunded="0"):
    return make_payment(
        booking, status="PAID", amount=amount, performed_at=when, refunded_amount=refunded
    )


def test_overview_shape_and_empty_values(admin):
    response = get(admin, "overview")
    assert response.status_code == 200
    assert response.data == {
        "bookings_today": 0, "bookings_active": 0, "revenue_today": "0.00",
        "revenue_month": "0.00", "occupancy_percent": "0.00", "total_slots": 0,
        "occupied_slots": 0, "lots_pending_review": 0, "refunds_needing_attention": 0,
        "overstay_due": 0,
    }  # fmt: skip


def test_overview_counts_money_and_occupancy(admin, world_a, make_bk, now):
    first = make_bk(world_a, slot=0)
    second = make_bk(world_a, slot=1, status="ACTIVE", hours=(-1, 1))
    make_bk(world_a, slot=2, status="PENDING_PAYMENT", hold_expires_at=now + timedelta(minutes=5))
    pay(first, "12000.50", now)
    pay(second, "8000", now, refunded="1000")  # net of the refund: 7000
    Slot.objects.filter(pk=world_a.slots[0].pk).update(status="OCCUPIED")
    Slot.objects.filter(pk=world_a.slots[1].pk).update(status="RESERVED")
    make_refund(first.payments.get(), amount="100", status="MANUAL")
    data = get(admin, "overview").data
    assert data["bookings_today"] == 2  # the unpaid hold does not count
    assert data["bookings_active"] == 1
    assert data["total_slots"] == 3 and data["occupied_slots"] == 2
    assert data["occupancy_percent"] == "66.67"
    assert data["refunds_needing_attention"] == 1
    assert data["revenue_today"] == data["revenue_month"] == "19000.50"


def test_revenue_today_and_month_use_tashkent_boundaries(admin, world_a, make_bk):
    anchor = datetime(2026, 10, 15, 12, 0, tzinfo=TZ)
    booking = make_bk(world_a)
    pay(booking, "1000", datetime(2026, 9, 30, 23, 59, 59, tzinfo=TZ))  # last month
    pay(booking, "2000", datetime(2026, 10, 1, 0, 0, 0, tzinfo=TZ))  # first instant of the month
    pay(booking, "4000", datetime(2026, 10, 14, 23, 59, 59, tzinfo=TZ))
    pay(booking, "8000", datetime(2026, 10, 15, 0, 0, 0, tzinfo=TZ))  # first instant of today
    pay(booking, "16000", datetime(2026, 10, 15, 11, 0, tzinfo=TZ), refunded="6000")  # net 10000
    scope = stats.Scope.build(admin)
    data = stats.overview(scope, now=anchor)
    assert data["revenue_today"] == "18000.00"
    assert data["revenue_month"] == "24000.00"


def test_revenue_series_groups_by_local_day_and_fills_gaps(admin, world_a, make_bk):
    booking = make_bk(world_a)
    other = make_bk(world_a, slot=1)
    pay(booking, "5000", datetime(2026, 10, 10, 23, 30, tzinfo=TZ))
    pay(other, "3000", datetime(2026, 10, 10, 0, 5, tzinfo=TZ))
    pay(booking, "700", datetime(2026, 10, 12, 8, 0, tzinfo=TZ))
    response = get(
        admin,
        "revenue",
        **{"from": "2026-10-10T00:00:00+05:00", "to": "2026-10-13T00:00:00+05:00"},
    )
    assert response.status_code == 200
    assert response.data["results"] == [
        {"date": "2026-10-10", "revenue": "8000.00", "bookings": 2},
        {"date": "2026-10-11", "revenue": "0.00", "bookings": 0},
        {"date": "2026-10-12", "revenue": "700.00", "bookings": 1},
    ]


def test_revenue_default_is_the_last_seven_days(admin):
    points = get(admin, "revenue").data["results"]
    assert len(points) == 7 and points[-1]["date"] == datetime.now(TZ).date().isoformat()


@pytest.mark.parametrize(
    "params",
    [
        {"from": "2026-10-12T00:00:00+05:00", "to": "2026-10-10T00:00:00+05:00"},
        {"from": "2026-01-01T00:00:00+05:00", "to": "2026-10-10T00:00:00+05:00"},
        {"from": "garbage"},
    ],
)
def test_revenue_rejects_bad_ranges(admin, params):
    assert get(admin, "revenue", **params).status_code == 400


def test_owner_scope_and_parking_lot_filter(owner_a, admin, world_a, world_b, make_bk, now):
    pay(make_bk(world_a), "1000", now)
    pay(make_bk(world_b), "5000", now)
    assert get(owner_a, "overview").data["revenue_month"] == "1000.00"
    assert get(admin, "overview").data["revenue_month"] == "6000.00"
    assert (
        get(admin, "overview", parking_lot=str(world_b.lot.pk)).data["revenue_month"] == "5000.00"
    )
    assert get(owner_a, "overview", parking_lot=str(world_b.lot.pk)).status_code == 404
    assert get(owner_a, "occupancy", parking_lot=str(world_b.lot.pk)).status_code == 404
    assert get(owner_a, "revenue", parking_lot=str(world_b.lot.pk)).status_code == 404
    assert get(admin, "overview", parking_lot="not-a-uuid").status_code == 400


def test_lots_pending_review_and_overstay_due(admin, owner_a, world_a, world_b, make_bk):
    ParkingLot.objects.filter(pk=world_b.lot.pk).update(status="PENDING_REVIEW")
    make_bk(
        world_a, status="OVERSTAY", hours=(-3, -1), overstay_status="due",
        overstay_amount="3000", overstay_minutes=20,
    )  # fmt: skip
    data = get(admin, "overview").data
    assert data["lots_pending_review"] == 1 and data["overstay_due"] == 1
    assert get(owner_a, "overview").data["lots_pending_review"] == 0


def test_occupancy_rows_per_active_lot(admin, world_a, world_b):
    Slot.objects.filter(pk=world_a.slots[0].pk).update(status="OCCUPIED")
    ParkingLot.objects.filter(pk=world_b.lot.pk).update(status="SUSPENDED")
    rows = get(admin, "occupancy").data["results"]
    assert rows == [
        {
            "parking_lot": {"id": world_a.lot.pk, "name": world_a.lot.name},
            "total_slots": 3,
            "occupied_slots": 1,
            "occupancy_percent": "33.33",
        }
    ]


def test_stats_use_a_fixed_number_of_queries(
    admin, world_a, make_bk, django_assert_max_num_queries
):
    for index in range(3):
        make_bk(world_a, slot=index, hours=(2 + index * 3, 4 + index * 3))
    with django_assert_max_num_queries(8):
        assert get(admin, "overview").status_code == 200
    with django_assert_max_num_queries(3):
        assert get(admin, "revenue").status_code == 200
    with django_assert_max_num_queries(3):
        assert get(admin, "occupancy").status_code == 200


def test_helpers():
    assert stats.percent(0, 0) == "0.00" and stats.percent(1, 3) == "33.33"
    assert stats.money(None) == "0.00" and stats.money("1.005") == "1.01"
    assert Booking.objects.count() == 0


def test_a_value_without_an_offset_is_read_as_tashkent_time(admin, world_a, make_bk):
    pay(make_bk(world_a), "500", datetime(2026, 10, 10, 1, 0, tzinfo=TZ))
    points = get(admin, "revenue", **{"from": "2026-10-10T00:00:00", "to": "2026-10-11T00:00:00"})
    assert points.data["results"] == [{"date": "2026-10-10", "revenue": "500.00", "bookings": 1}]


def test_out_of_service_slots_are_not_in_the_occupancy_denominator(admin, world_a):
    Slot.objects.filter(pk=world_a.slots[2].pk).update(status="OUT_OF_SERVICE")
    Slot.objects.filter(pk=world_a.slots[0].pk).update(status="OCCUPIED")
    overview = get(admin, "overview").data
    assert overview["total_slots"] == 2 and overview["occupancy_percent"] == "50.00"
    row = get(admin, "occupancy").data["results"][0]
    assert row["total_slots"] == 2 and row["occupancy_percent"] == "50.00"
