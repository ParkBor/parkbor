"""WebSocket tickets on a REAL Redis: SET NX EX issue, GETDEL consume (ARCHITECTURE 12).

The race that matters: two sockets presenting the same (logged / leaked) ticket at the same
instant must not both authenticate. GETDEL is atomic only on a real server (fakeredis cannot
prove it). Skipped without REDIS_TEST_URL, mandatory in CI (REQUIRE_REDIS=1).
"""

import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import pytest

from apps.realtime import tickets

pytestmark = pytest.mark.redis


def consume_together(ticket, racers):
    barrier = threading.Barrier(racers)

    def run(_i):
        barrier.wait(timeout=30)
        return tickets.consume_ticket(ticket)

    with ThreadPoolExecutor(max_workers=racers) as pool:
        return list(pool.map(run, range(racers)))


def test_a_ticket_authenticates_exactly_one_of_many_simultaneous_sockets(real_redis):
    for _round in range(10):  # repeat: a race that is lost 1 time in 10 must still show up
        ticket = tickets.issue_ticket("user-1")
        results = consume_together(ticket, racers=64)
        assert Counter(results) == {"user-1": 1, None: 63}


def test_many_tickets_consumed_concurrently_each_work_once_for_their_own_user(real_redis):
    issued = {tickets.issue_ticket(f"user-{n}"): f"user-{n}" for n in range(40)}
    assert len(issued) == 40  # no collisions
    jobs = [t for t in issued for _ in range(5)]  # every ticket offered 5 times
    barrier = threading.Barrier(len(jobs))

    def run(ticket):
        barrier.wait(timeout=30)
        return ticket, tickets.consume_ticket(ticket)

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        outcomes = list(pool.map(run, jobs))
    for ticket, owner in issued.items():
        got = [value for t, value in outcomes if t == ticket]
        assert sorted(g for g in got if g) == [owner], (ticket, got)
    assert real_redis.keys("ws:ticket:*") == []


def test_a_ticket_expires_for_real(real_redis, settings):
    settings.WS_TICKET_TTL_SECONDS = 1
    ticket = tickets.issue_ticket("user-1")
    time.sleep(1.5)
    assert tickets.consume_ticket(ticket) is None


def test_redis_only_ever_sees_the_hash_of_a_ticket(real_redis):
    ticket = tickets.issue_ticket("user-1")
    keys = real_redis.keys("*")
    assert len(keys) == 1 and ticket not in keys[0]
    assert real_redis.get(keys[0]) == "user-1"
    assert 0 < real_redis.ttl(keys[0]) <= 30


def test_malformed_tickets_never_reach_redis(real_redis):
    real_redis.set("ws:ticket:probe", "x")
    for bad in ("", "short", "a" * 200, "has space in it......", None, 123):
        assert tickets.consume_ticket(bad) is None
    assert real_redis.get("ws:ticket:probe") == "x"


def test_issuing_in_parallel_never_hands_out_the_same_ticket_twice(real_redis):
    barrier = threading.Barrier(100)

    def run(i):
        barrier.wait(timeout=30)
        return tickets.issue_ticket(f"user-{i}")

    with ThreadPoolExecutor(max_workers=100) as pool:
        issued = list(pool.map(run, range(100)))
    assert len(set(issued)) == 100
    assert len(real_redis.keys("ws:ticket:*")) == 100
