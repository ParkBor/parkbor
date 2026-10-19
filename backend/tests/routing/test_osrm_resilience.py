"""OsrmClient: real size cap, overall deadline, circuit breaker, URL validation (no network)."""

import fakeredis
import httpx
import pytest
from django.core.exceptions import ImproperlyConfigured

from apps.core import redis_client
from apps.routing import osrm_client
from apps.routing.osrm_client import BREAKER_KEY, BREAKER_TTL_SECONDS, OsrmClient, OsrmError
from apps.routing.url_check import validate_osrm_url

ORIGIN = (41.3113, 69.2743)
DESTS = [(41.32, 69.28), (41.33, 69.29)]
OK = {"code": "Ok", "durations": [[5, 7]]}


def make(handler, **kw):
    return OsrmClient(httpx.Client(transport=httpx.MockTransport(handler)), **kw)


class TestStreamingSizeCap:
    def test_declared_content_length_over_limit_is_rejected_without_reading(self):
        def handler(request):
            return httpx.Response(200, headers={"content-length": "50000000"}, content=b"{}")

        with pytest.raises(OsrmError) as info:
            make(handler).table(ORIGIN, DESTS)
        assert info.value.reason == "too_large"

    def test_chunked_body_without_length_is_cut_off_at_the_limit(self):
        read = []

        def chunks():
            for _ in range(100):
                read.append(1)
                yield b"x" * 100_000

        def handler(request):
            return httpx.Response(200, content=chunks())

        with pytest.raises(OsrmError) as info:
            make(handler).table(ORIGIN, DESTS)
        assert info.value.reason == "too_large"
        assert len(read) < 20  # stopped early, did not drain 10 MB

    def test_normal_body_still_works(self):
        client = make(lambda request: httpx.Response(200, json=OK))
        assert client.table(ORIGIN, DESTS) == [5.0, 7.0]


class TestDeadline:
    def test_total_time_budget_is_enforced_between_chunks(self):
        now = [0.0]

        def chunks():
            for _ in range(3):
                now[0] += 2.0  # each chunk "takes" 2 s
                yield b" "

        def handler(request):
            return httpx.Response(200, content=chunks())

        client = make(handler, clock=lambda: now[0])
        with pytest.raises(OsrmError) as info:
            client.table(ORIGIN, DESTS)
        assert info.value.reason == "timeout"

    def test_per_request_timeout_never_exceeds_remaining_budget(self):
        seen = {}

        def handler(request):
            seen.update(request.extensions["timeout"])
            return httpx.Response(200, json=OK)

        make(handler).table(ORIGIN, DESTS)
        assert seen["read"] <= osrm_client.OSRM_TIMEOUT_SECONDS
        assert seen["connect"] <= osrm_client.OSRM_CONNECT_TIMEOUT_SECONDS


class TestCircuitBreaker:
    def failing(self, calls):
        def handler(request):
            calls.append(1)
            raise httpx.ConnectError("refused", request=request)

        return handler

    def test_one_transport_failure_does_not_open_the_breaker(self, fake_redis):
        with pytest.raises(OsrmError):
            make(self.failing([])).table(ORIGIN, DESTS)
        assert fake_redis.get(BREAKER_KEY) is None
        assert fake_redis.get(osrm_client.FAILURE_KEY) == "1"

    def test_three_failures_inside_the_window_open_the_breaker(self, fake_redis):
        for _ in range(osrm_client.BREAKER_FAILURE_THRESHOLD):
            with pytest.raises(OsrmError):
                make(self.failing([])).table(ORIGIN, DESTS)
        assert fake_redis.get(BREAKER_KEY) == "1"
        assert 0 < fake_redis.ttl(BREAKER_KEY) <= BREAKER_TTL_SECONDS == 30
        assert 0 < fake_redis.ttl(osrm_client.FAILURE_KEY) <= osrm_client.BREAKER_WINDOW_SECONDS

    def test_failures_spread_over_more_than_the_window_do_not_add_up(self, fake_redis):
        for _ in range(osrm_client.BREAKER_FAILURE_THRESHOLD + 2):
            with pytest.raises(OsrmError):
                make(self.failing([])).table(ORIGIN, DESTS)
            fake_redis.delete(osrm_client.FAILURE_KEY)  # the 5 s window expired
        assert fake_redis.get(BREAKER_KEY) is None

    def test_failure_counter_always_gets_an_expiry(self, fake_redis):
        fake_redis.set(osrm_client.FAILURE_KEY, "1")  # a counter left without TTL
        with pytest.raises(OsrmError):
            make(self.failing([])).table(ORIGIN, DESTS)
        assert fake_redis.ttl(osrm_client.FAILURE_KEY) > 0

    def test_open_breaker_skips_the_network(self, fake_redis):
        fake_redis.set(BREAKER_KEY, "1", ex=30)
        calls = []
        with pytest.raises(OsrmError) as info:
            make(self.failing(calls)).table(ORIGIN, DESTS)
        assert info.value.reason == "circuit_open"
        assert calls == []

    def test_timeouts_and_5xx_open_it_but_4xx_and_bad_payload_do_not(self, fake_redis):
        for response in (httpx.Response(400, json={}), httpx.Response(200, json={"code": "Ok"})):
            with pytest.raises(OsrmError):
                make(lambda request, response=response: response).table(ORIGIN, DESTS)
            assert fake_redis.get(BREAKER_KEY) is None
        for _ in range(osrm_client.BREAKER_FAILURE_THRESHOLD):
            with pytest.raises(OsrmError):
                make(lambda r: httpx.Response(503, json={})).table(ORIGIN, DESTS)
        assert fake_redis.get(BREAKER_KEY) == "1"

    def test_success_does_not_open_it(self, fake_redis):
        make(lambda r: httpx.Response(200, json=OK)).table(ORIGIN, DESTS)
        assert fake_redis.get(BREAKER_KEY) is None

    def test_redis_outage_fails_open(self):
        class Broken(fakeredis.FakeRedis):
            def get(self, *a, **k):
                raise redis_client.redis.ConnectionError("down")

            def set(self, *a, **k):
                raise redis_client.redis.ConnectionError("down")

        redis_client.set_redis_client(Broken(decode_responses=True))
        assert make(lambda r: httpx.Response(200, json=OK)).table(ORIGIN, DESTS) == [5.0, 7.0]
        with pytest.raises(OsrmError):
            make(self.failing([])).table(ORIGIN, DESTS)  # no crash while recording the failure

    def test_misconfigured_redis_fails_open(self, monkeypatch):
        def broken():
            raise ImproperlyConfigured("no REDIS_URL")

        monkeypatch.setattr(osrm_client, "get_redis", broken)
        assert make(lambda r: httpx.Response(200, json=OK)).table(ORIGIN, DESTS) == [5.0, 7.0]


class TestClientShape:
    def test_module_table_delegates_to_osrm_client_with_given_http_client(self):
        http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=OK)))
        assert osrm_client.table(ORIGIN, DESTS, client=http) == [5.0, 7.0]

    def test_client_is_reusable_for_many_requests(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(200, json=OK)

        client = make(handler)
        client.table(ORIGIN, DESTS)
        client.table(ORIGIN, DESTS)
        assert len(calls) == 2


class TestUrlValidation:
    @pytest.mark.parametrize(
        "url", ["http://localhost:5000", "https://osrm.parkbor.uz", "http://osrm:5000/"]
    )
    def test_accepts_http_and_https(self, url):
        assert validate_osrm_url(url) == url

    @pytest.mark.parametrize(
        "url",
        [
            "",
            "ftp://host",
            "file:///etc/passwd",
            "localhost:5000",
            "//host",
            "javascript:1",
            "http://",
            "http://user:pw@host:5000",
            "http://user@host",
            "http://host:5000?x=1",
            "http://host:5000#frag",
            "http://host:5000/some/path",
            "http://host:99999",
        ],
    )
    def test_rejects_everything_else(self, url):
        with pytest.raises(ImproperlyConfigured):
            validate_osrm_url(url)

    def test_error_does_not_echo_credentials(self):
        with pytest.raises(ImproperlyConfigured) as info:
            validate_osrm_url("ftp://user:s3cret@host")
        assert "s3cret" not in str(info.value)

    def test_base_settings_use_the_validator(self):
        from django.conf import settings

        assert validate_osrm_url(settings.OSRM_URL) == settings.OSRM_URL
