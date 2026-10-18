"""The per-user WebSocket connection registry (one Lua script) on a REAL Redis.

fakeredis runs Lua through lupa, which is close but not identical; the atomicity claim ("two
concurrent connects of one user cannot both see room") is only worth anything on the real
server. Skipped without REDIS_TEST_URL, mandatory in CI (REQUIRE_REDIS=1).
"""

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from apps.realtime import connections

pytestmark = pytest.mark.redis

LIMIT = 5


@pytest.fixture(autouse=True)
def _limits(settings):
    settings.WS_MAX_CONNECTIONS_PER_USER = LIMIT
    settings.WS_HEARTBEAT_SECONDS = 30
    settings.WS_IDLE_TIMEOUT_SECONDS = 90


def together(jobs):
    barrier = threading.Barrier(len(jobs))

    def run(job):
        barrier.wait(timeout=30)
        return job()

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        return list(pool.map(run, jobs))


def members(real_redis, user):
    return set(real_redis.zrange(f"ws:conns:{user}", 0, -1))


def test_forty_simultaneous_connects_leave_exactly_the_limit(real_redis):
    # score = connect order, so the survivors must be the five newest whatever the arrival order
    jobs = [lambda n=n: connections.register("u", f"ch-{n:02d}", now=1000 + n) for n in range(40)]
    victims = together(jobs)
    assert real_redis.zcard("ws:conns:u") == LIMIT
    assert members(real_redis, "u") == {f"ch-{n:02d}" for n in range(35, 40)}
    evicted = {name for batch in victims for name in batch}
    assert evicted.isdisjoint(members(real_redis, "u"))
    # an evicted channel is reported exactly once (or was its own victim: filtered by design)
    flat = [name for batch in victims for name in batch]
    assert len(flat) == len(set(flat))


def test_users_do_not_share_a_cap(real_redis):
    jobs = [
        lambda u=u, n=n: connections.register(f"user-{u}", f"ch-{u}-{n}", now=1000 + n)
        for u in range(8)
        for n in range(12)
    ]
    together(jobs)
    for u in range(8):
        assert real_redis.zcard(f"ws:conns:user-{u}") == LIMIT


def test_unregister_makes_room_without_evicting_anyone(real_redis):
    for n in range(LIMIT):
        assert connections.register("u", f"ch-{n}", now=1000 + n) == []
    connections.unregister("u", "ch-0")
    assert connections.register("u", "ch-new", now=2000) == []
    assert real_redis.zcard("ws:conns:u") == LIMIT


def test_dead_entries_are_swept_by_the_same_script(real_redis):
    for n in range(LIMIT):
        connections.register("u", f"dead-{n}", now=100 + n)
    # long after the last heartbeat (stale window = max(3 * 30, 90) s): all five are dead
    assert connections.register("u", "alive", now=100_000) == []
    assert members(real_redis, "u") == {"alive"}


def test_the_key_gets_a_ttl(real_redis):
    connections.register("u", "ch", now=1000)
    assert 0 < real_redis.ttl("ws:conns:u") <= connections.KEY_TTL_SECONDS


def test_touch_refreshes_only_registered_members(real_redis):
    connections.register("u", "ch", now=1000)
    connections.touch("u", "ch", now=1500)
    assert real_redis.zscore("ws:conns:u", "ch") == 1500
    connections.unregister("u", "ch")
    connections.touch("u", "ch", now=1600)  # XX: must not resurrect it
    assert real_redis.zscore("ws:conns:u", "ch") is None


def test_the_script_runs_atomically_while_the_set_is_being_hammered(real_redis):
    """Heartbeats, unregisters and registers interleaved: the set never exceeds the limit."""
    for n in range(LIMIT):
        connections.register("u", f"seed-{n}", now=1000 + n)
    seen_sizes = [real_redis.zcard("ws:conns:u")]
    stop = threading.Event()

    def watcher():
        while not stop.is_set():
            seen_sizes.append(real_redis.zcard("ws:conns:u"))

    thread = threading.Thread(target=watcher)
    thread.start()
    try:
        jobs = []
        for n in range(30):
            jobs.append(lambda n=n: connections.register("u", f"new-{n}", now=2000 + n))
            jobs.append(lambda n=n: connections.touch("u", f"seed-{n % LIMIT}", now=1500))
        together(jobs)
    finally:
        stop.set()
        thread.join(timeout=10)
    assert max(seen_sizes) <= LIMIT  # no moment where two connects both "saw room"
    assert real_redis.zcard("ws:conns:u") <= LIMIT


def test_a_late_newcomer_is_never_its_own_victim(real_redis):
    for n in range(LIMIT):
        connections.register("u", f"ch-{n}", now=1000 + n)
    victims = connections.register("u", "late", now=10)  # older than everyone in the set
    assert "late" in members(real_redis, "u")  # scored above the newest entry
    assert victims == ["ch-0"]  # the genuinely oldest connection is the one evicted
    assert real_redis.zcard("ws:conns:u") == LIMIT
