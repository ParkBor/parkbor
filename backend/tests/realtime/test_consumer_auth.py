"""Connecting: ticket authentication, origin check, and what an unauthenticated socket may do."""

import json

import pytest
from asgiref.sync import sync_to_async

from apps.realtime import tickets
from tests.helpers import make_user
from tests.realtime.ws_helpers import expect_close, new_communicator, open_socket, send

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


@pytest.fixture
def driver():
    return make_user("DRIVER")


async def test_valid_ticket_in_the_query_authenticates(driver, fake_redis):
    comm = await open_socket(driver)
    await comm.disconnect()


async def test_ticket_is_one_time(driver, fake_redis):
    ticket = tickets.issue_ticket(str(driver.pk))
    first = new_communicator(ticket=ticket)
    assert (await first.connect())[0]
    assert await first.receive_json_from() == {"type": "ready"}

    replay = new_communicator(ticket=ticket)
    assert (await replay.connect())[0]  # accepted first, so the client can read the close code
    await expect_close(replay, 4401)
    await first.disconnect()


async def test_unknown_ticket_closes_4401(fake_redis):
    comm = new_communicator(ticket="A" * 22)
    assert (await comm.connect())[0]
    await expect_close(comm, 4401)


async def test_expired_ticket_closes_4401(driver, fake_redis):
    ticket = tickets.issue_ticket(str(driver.pk))
    fake_redis.flushall()
    comm = new_communicator(ticket=ticket)
    assert (await comm.connect())[0]
    await expect_close(comm, 4401)


async def test_inactive_user_closes_4401(fake_redis):
    user = await sync_to_async(make_user)("DRIVER", is_active=False)
    comm = new_communicator(ticket=tickets.issue_ticket(str(user.pk)))
    assert (await comm.connect())[0]
    await expect_close(comm, 4401)


async def test_deleted_user_closes_4401(driver, fake_redis):
    ticket = tickets.issue_ticket(str(driver.pk))
    await driver.adelete()
    comm = new_communicator(ticket=ticket)
    assert (await comm.connect())[0]
    await expect_close(comm, 4401)


async def test_the_old_jwt_query_parameter_is_not_accepted(driver, settings, fake_redis):
    settings.WS_AUTH_TIMEOUT_SECONDS = 0.3
    from rest_framework_simplejwt.tokens import AccessToken

    jwt = str(AccessToken.for_user(driver))
    comm = new_communicator(query=f"token={jwt}")
    assert (await comm.connect())[0]
    await expect_close(comm, 4401)  # never authenticated, then the auth window ran out


async def test_two_ticket_parameters_are_rejected(driver, fake_redis):
    good = tickets.issue_ticket(str(driver.pk))
    comm = new_communicator(ticket=good, query=f"ticket={tickets.issue_ticket(str(driver.pk))}")
    assert (await comm.connect())[0]
    await expect_close(comm, 4401)


async def test_first_message_auth_is_accepted(driver, fake_redis):
    comm = new_communicator()
    assert (await comm.connect())[0]
    await send(comm, type="auth", ticket=tickets.issue_ticket(str(driver.pk)))
    assert await comm.receive_json_from() == {"type": "ready"}
    await comm.disconnect()


async def test_first_message_auth_with_a_bad_ticket_closes_4401(fake_redis):
    comm = new_communicator()
    assert (await comm.connect())[0]
    await send(comm, type="auth", ticket="nope")
    await expect_close(comm, 4401)


async def test_other_messages_before_auth_close_4401(fake_redis):
    comm = new_communicator()
    assert (await comm.connect())[0]
    await send(comm, type="subscribe", groups=[])
    await expect_close(comm, 4401)


async def test_silence_before_auth_closes_4401(settings, fake_redis):
    settings.WS_AUTH_TIMEOUT_SECONDS = 0.2
    comm = new_communicator()
    assert (await comm.connect())[0]
    await expect_close(comm, 4401)


async def test_auth_after_authentication_is_ignored(driver, fake_redis):
    comm = await open_socket(driver)
    await send(comm, type="auth", ticket=tickets.issue_ticket(str(driver.pk)))
    await send(comm, type="ping")
    assert await comm.receive_json_from() == {"type": "pong"}
    await comm.disconnect()


async def test_store_down_closes_1013(driver, fake_redis, monkeypatch):
    import redis

    def boom(*a, **k):
        raise redis.ConnectionError("down")

    monkeypatch.setattr(fake_redis, "getdel", boom)
    comm = new_communicator(ticket="A" * 22)
    assert (await comm.connect())[0]
    await expect_close(comm, 1013)


# --- origin -------------------------------------------------------------------------------


async def test_a_mobile_client_without_origin_is_allowed(driver, fake_redis):
    comm = await open_socket(driver)  # no Origin header
    await comm.disconnect()


async def test_an_allowed_origin_is_accepted(driver, settings, fake_redis):
    settings.ALLOWED_HOSTS = ["testserver"]
    comm = await open_socket(driver, origin="https://testserver")
    await comm.disconnect()


async def test_a_cors_origin_is_accepted(driver, settings, fake_redis):
    settings.CORS_ALLOWED_ORIGINS = ["https://admin.habi.uz"]
    comm = await open_socket(driver, origin="https://admin.habi.uz")
    await comm.disconnect()


@pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://testserver.evil.com"])
async def test_a_foreign_origin_is_refused_at_handshake(driver, fake_redis, origin):
    ticket = tickets.issue_ticket(str(driver.pk))
    comm = new_communicator(ticket=ticket, origin=origin)
    connected, _ = await comm.connect()
    assert connected is False
    # the origin check runs before the consumer: the ticket was not spent
    assert tickets.consume_ticket(ticket) == str(driver.pk)


async def test_unknown_websocket_path_is_not_routed(driver, fake_redis):
    comm = new_communicator(ticket=tickets.issue_ticket(str(driver.pk)), path="/ws/other/")
    try:
        connected, _ = await comm.connect()
        assert connected is False
    except ValueError:
        pass  # the router refuses a path it has no route for


async def test_the_ticket_is_not_logged(driver, fake_redis, caplog):
    ticket = tickets.issue_ticket(str(driver.pk))
    comm = new_communicator(ticket=ticket)
    with caplog.at_level("DEBUG"):
        await comm.connect()
        await comm.receive_json_from()
        await comm.disconnect()
    assert ticket not in caplog.text
    assert json.dumps({"ticket": ticket}) not in caplog.text
