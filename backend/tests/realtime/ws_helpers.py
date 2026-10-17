"""Helpers for WebSocket tests: connect through the real ASGI application."""

import json

from channels.testing import WebsocketCommunicator

from apps.realtime import tickets

PATH = "/ws/availability/"


def application():
    from config.asgi import application as app

    return app


def new_communicator(*, ticket=None, query="", origin=None, path=PATH):
    headers = [(b"origin", origin.encode())] if origin else []
    if ticket is not None:
        query = f"ticket={ticket}" + (f"&{query}" if query else "")
    url = f"{path}?{query}" if query else path
    return WebsocketCommunicator(application(), url, headers=headers)


async def open_socket(user, **kwargs):
    """Connect with a fresh ticket and wait for the ``ready`` message."""
    comm = new_communicator(ticket=tickets.issue_ticket(str(user.pk)), **kwargs)
    connected, _ = await comm.connect()
    assert connected
    assert await comm.receive_json_from() == {"type": "ready"}
    return comm


async def send(comm, **message):
    await comm.send_to(text_data=json.dumps(message))


async def expect_close(comm, code, timeout=2):
    """The next frame must be a close with ``code``."""
    event = await comm.receive_output(timeout)
    assert event["type"] == "websocket.close", event
    assert event["code"] == code
    return event


async def drain(comm):
    """Discard everything already queued for the client."""
    while not await comm.receive_nothing(timeout=0.05):
        await comm.receive_output(timeout=0.05)
