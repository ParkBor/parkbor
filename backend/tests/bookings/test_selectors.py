"""count_availability (SQL COUNTs for quotes) must agree with build_pool (used to book)."""

from datetime import timedelta

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.bookings import quotes, selectors
from apps.bookings.state import BookingStatus as S
from apps.parking.models import Slot, SlotStatus
from tests.bookings.factories import make_booking, make_vehicle, make_world
from tests.helpers import make_user

pytestmark = pytest.mark.django_db

WINDOW = timedelta(minutes=15)


def both(world, start, end, now, slot_type="STANDARD"):
    pool = selectors.build_pool(
        world.lot.pk, slot_type, start, end, now=now, immediate_window=WINDOW
    )
    total, free = selectors.count_availability(
        world.lot.pk, slot_type, start, end, now=now, immediate_window=WINDOW
    )
    return (pool.total, pool.available), (total, free)


def book(world, slot, start, end, status=S.CONFIRMED):
    user = make_user("DRIVER")
    return make_booking(
        user=user, slot=slot, vehicle=make_vehicle(user), start=start, end=end, status=status
    )


def test_agree_on_an_empty_lot(now):
    world = make_world(slots=4)
    pool, counts = both(world, now + timedelta(hours=2), now + timedelta(hours=3), now)
    assert pool == counts == (4, 4)


def test_agree_with_overlaps_adjacency_finished_and_out_of_service(now):
    world = make_world(slots=6)
    start, end = now + timedelta(hours=2), now + timedelta(hours=4)
    book(world, world.slots[0], start, end)  # exact overlap: busy
    book(world, world.slots[1], start - timedelta(hours=1), start + timedelta(minutes=1))  # busy
    book(world, world.slots[2], end, end + timedelta(hours=1))  # adjacent: free
    book(world, world.slots[3], start, end, status=S.CANCELLED)  # finished: free
    Slot.objects.filter(pk=world.slots[4].pk).update(status=SlotStatus.OUT_OF_SERVICE)
    pool, counts = both(world, start, end, now)
    # working: 5 (one is out of service); free: the adjacent one, the cancelled one, the idle one
    assert pool == counts == (5, 3)


def test_agree_on_physically_occupied_slots_only_for_immediate_starts(now):
    world = make_world(slots=3)
    Slot.objects.filter(pk=world.slots[0].pk).update(status=SlotStatus.OCCUPIED)
    soon = both(world, now + timedelta(minutes=5), now + timedelta(hours=1), now)
    later = both(world, now + timedelta(hours=3), now + timedelta(hours=4), now)
    assert soon[0] == soon[1] == (3, 2)
    assert later[0] == later[1] == (3, 3)


def test_agree_per_slot_type(now):
    world = make_world(slots=2)
    pool, counts = both(world, now + timedelta(hours=2), now + timedelta(hours=3), now, "EV")
    assert pool == counts == (0, 0)


def test_quote_queries_do_not_grow_with_the_size_of_the_lot(driver, now):
    start, end = now + timedelta(hours=2), now + timedelta(hours=3)

    def queries(slot_count):
        world = make_world(slots=slot_count)
        for slot in world.slots[: slot_count // 2]:
            book(world, slot, start, end)
        with CaptureQueriesContext(connection) as captured:
            quotes.get_availability(
                lot_id=world.lot.pk, slot_type="STANDARD", start=start, end=end, now=now
            )
            quotes.quote_price(
                lot_id=world.lot.pk, slot_type="STANDARD", start=start, end=end, now=now
            )
        return len(captured)

    assert queries(4) == queries(40)
