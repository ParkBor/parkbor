"""Edge paths flagged by the coverage report: Redis failures in the debounce, task wrappers,
unusable data, and consumer corner cases."""

import uuid

import pytest
import redis
from asgiref.sync import sync_to_async

from apps.realtime import groups, publishers, queries
from tests.bookings.factories import make_world
from tests.helpers import make_user
from tests.realtime.ws_helpers import drain, expect_close, new_communicator, open_socket, send


@pytest.mark.django_db
class TestPublisherEdges:
    def test_a_lot_without_a_usable_location_still_reaches_its_lot_group(self, layer, monkeypatch):
        world = make_world(slots=1)
        monkeypatch.setattr(
            queries,
            "lots_snapshot",
            lambda ids: {
                str(world.lot.pk): {
                    "lot_id": str(world.lot.pk),
                    "free_slots": 1,
                    "total_slots": 1,
                    "lng_lat": (500.0, 500.0),  # outside the valid range
                }
            },
        )
        assert publishers.broadcast_availability(world.lot.pk) is True
        assert [g for g, _ in layer.sent] == [groups.lot_group(world.lot.pk)]

    def test_redis_failing_after_the_window_check_sends_at_once(
        self, layer, fake_redis, monkeypatch
    ):
        world = make_world(slots=1)
        calls = []
        real_set = fake_redis.set

        def flaky_set(key, *args, **kwargs):
            calls.append(key)
            if "trail" in key:
                raise redis.ConnectionError("down")
            return real_set(key, *args, **kwargs)

        monkeypatch.setattr(fake_redis, "set", flaky_set)
        publishers.on_availability_changed(lot_id=world.lot.pk)  # opens the window
        publishers.on_availability_changed(lot_id=world.lot.pk)  # window busy, trail unknown
        assert len(layer.payloads(groups.lot_group(world.lot.pk))) == 2

    def test_an_already_scheduled_flush_means_no_second_message(self, layer, fake_redis):
        world = make_world(slots=1)
        publishers.on_availability_changed(lot_id=world.lot.pk)
        fake_redis.set(f"rt:avail:trail:{world.lot.pk}", "1", px=5000)
        publishers.on_availability_changed(lot_id=world.lot.pk)
        assert len(layer.payloads(groups.lot_group(world.lot.pk))) == 1

    def test_releasing_and_checking_the_flag_survive_redis_errors(self, fake_redis, monkeypatch):
        def boom(*a, **k):
            raise redis.ConnectionError("down")

        monkeypatch.setattr(fake_redis, "delete", boom)
        monkeypatch.setattr(fake_redis, "exists", boom)
        publishers._release_trailing_flush("x")
        assert publishers._flush_is_scheduled("x") is False


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_a_ticket_holding_a_non_uuid_owner_is_refused(fake_redis):
    fake_redis.set("ws:ticket:" + __import__("hashlib").sha256(b"A" * 22).hexdigest(), "not-a-uuid")
    comm = new_communicator(ticket="A" * 22)
    assert (await comm.connect())[0]
    await expect_close(comm, 4401)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_an_account_disabled_mid_session_cannot_subscribe(fake_redis):
    from apps.accounts.models import User

    user = await sync_to_async(make_user)("OPERATOR")
    world = await sync_to_async(make_world)(slots=1)
    comm = await open_socket(user)
    await sync_to_async(User.objects.filter(pk=user.pk).update)(is_active=False)
    await send(comm, type="subscribe", groups=[{"kind": "operator_lot", "id": str(world.lot.pk)}])
    await expect_close(comm, 4401)


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_unsubscribing_something_never_joined_is_harmless(fake_redis):
    user = await sync_to_async(make_user)("DRIVER")
    comm = await open_socket(user)
    await send(
        comm,
        type="unsubscribe",
        groups=[{"kind": "lot", "id": str(uuid.uuid4())}, {"kind": "bad", "id": "x"}, "junk"],
    )
    assert await comm.receive_json_from() == {"type": "unsubscribed", "groups": []}
    await send(comm, type="unsubscribe", groups="not a list")
    assert await comm.receive_json_from() == {"type": "error", "code": "invalid_groups"}
    await drain(comm)
    await comm.disconnect()
