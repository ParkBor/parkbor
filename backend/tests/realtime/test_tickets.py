"""WebSocket tickets: one-time, short-lived, bound to a user, never stored in clear."""

import hashlib

import pytest
import redis

from apps.realtime import tickets
from tests.helpers import client_for, make_user

pytestmark = pytest.mark.django_db


def test_ticket_is_urlsafe_with_at_least_128_bits(fake_redis):
    ticket = tickets.issue_ticket("u-1")
    assert len(ticket) >= 22  # 16 random bytes, base64url
    assert all(c.isalnum() or c in "-_" for c in ticket)
    assert tickets.issue_ticket("u-1") != ticket


def test_ticket_is_stored_hashed_with_a_30_second_ttl(fake_redis):
    ticket = tickets.issue_ticket("u-1")
    key = f"ws:ticket:{hashlib.sha256(ticket.encode()).hexdigest()}"
    assert fake_redis.get(key) == "u-1"
    assert 0 < fake_redis.ttl(key) <= 30
    assert ticket not in "".join(fake_redis.keys("*"))


def test_ticket_works_once_and_binds_to_its_user(fake_redis):
    ticket = tickets.issue_ticket("u-1")
    assert tickets.consume_ticket(ticket) == "u-1"
    assert tickets.consume_ticket(ticket) is None  # replay


def test_expired_ticket_is_refused(fake_redis):
    ticket = tickets.issue_ticket("u-1")
    fake_redis.flushall()  # what Redis does at the end of the TTL
    assert tickets.consume_ticket(ticket) is None


@pytest.mark.parametrize("junk", ["", None, 123, "x" * 200, "no spaces allowed", "ü" * 22])
def test_malformed_tickets_are_refused_without_touching_redis(fake_redis, junk):
    assert tickets.consume_ticket(junk) is None


def test_collision_is_retried_never_overwritten(fake_redis, monkeypatch):
    first = tickets.issue_ticket("u-1")
    values = iter([first, "B" * 22])
    monkeypatch.setattr(tickets.secrets, "token_urlsafe", lambda n: next(values))
    second = tickets.issue_ticket("u-2")
    assert second == "B" * 22
    assert tickets.consume_ticket(first) == "u-1"  # not hijacked


def test_store_failure_on_issue_is_reported(fake_redis, monkeypatch):
    def boom(*a, **k):
        raise redis.ConnectionError("down")

    monkeypatch.setattr(fake_redis, "set", boom)
    with pytest.raises(tickets.TicketStoreUnavailable):
        tickets.issue_ticket("u-1")


def test_store_failure_on_consume_is_reported(fake_redis, monkeypatch):
    def boom(*a, **k):
        raise redis.ConnectionError("down")

    monkeypatch.setattr(fake_redis, "getdel", boom)
    with pytest.raises(tickets.TicketStoreUnavailable):
        tickets.consume_ticket("A" * 22)


# --- POST /api/v1/ws/ticket ----------------------------------------------------------------


def test_endpoint_requires_authentication():
    from rest_framework.test import APIClient

    assert APIClient().post("/api/v1/ws/ticket").status_code == 401


def test_endpoint_issues_a_ticket_for_the_caller(fake_redis):
    user = make_user("DRIVER")
    response = client_for(user).post("/api/v1/ws/ticket")
    assert response.status_code == 200
    assert response.json()["expires_in"] == 30
    assert tickets.consume_ticket(response.json()["ticket"]) == str(user.pk)
    assert response["Cache-Control"] == "no-store"


def test_endpoint_is_throttled_to_30_per_minute(fake_redis):
    client = client_for(make_user("DRIVER"))
    codes = [client.post("/api/v1/ws/ticket").status_code for _ in range(31)]
    assert codes[:30] == [200] * 30
    assert codes[30] == 429


def test_endpoint_answers_503_when_the_store_is_down(fake_redis, monkeypatch):
    def boom(*a, **k):
        raise redis.ConnectionError("down")

    monkeypatch.setattr(fake_redis, "set", boom)
    response = client_for(make_user("DRIVER")).post("/api/v1/ws/ticket")
    assert response.status_code == 503
    assert response.json()["code"] == "service_unavailable"


def test_disabled_user_gets_no_ticket(fake_redis):
    user = make_user("DRIVER", is_active=False)
    assert client_for(user).post("/api/v1/ws/ticket").status_code in (401, 403)
