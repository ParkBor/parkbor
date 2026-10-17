"""OSRM Table client: URL building, response validation, transport failures (no network)."""

import json
import logging

import httpx
import pytest

from apps.routing import osrm_client
from apps.routing.osrm_client import OsrmError, build_table_path, parse_table_response, table

ORIGIN = (41.3113, 69.2743)
DESTS = [(41.32, 69.28), (41.33, 69.29)]


def client_with(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def ok_payload(row):
    return {"code": "Ok", "durations": [row]}


class TestBuildTablePath:
    def test_lng_lat_order_sources_and_destinations(self):
        path = build_table_path(ORIGIN, DESTS)
        assert path.startswith("/table/v1/driving/69.274300,41.311300;69.280000,41.320000;")
        assert "sources=0" in path
        assert "destinations=1;2" in path
        assert "annotations=duration" in path

    def test_empty_destinations_rejected(self):
        with pytest.raises(ValueError, match="destination"):
            build_table_path(ORIGIN, [])

    def test_too_many_destinations_rejected(self):
        with pytest.raises(ValueError, match="destination"):
            build_table_path(ORIGIN, [(41.0, 69.0)] * 151)

    @pytest.mark.parametrize("bad", [(float("nan"), 1.0), (91.0, 0.0), (0.0, 181.0)])
    def test_invalid_coordinates_rejected(self, bad):
        with pytest.raises(ValueError, match="coordinate"):
            build_table_path(bad, DESTS)

    def test_only_numeric_text_ends_up_in_the_path(self):
        path = build_table_path(ORIGIN, DESTS)
        assert set(path) <= set("/table/v1/driving0123456789.,;?=&abcdefghijklmnopqrstuvwxyz_-")


class TestParseTableResponse:
    def test_valid(self):
        assert parse_table_response(ok_payload([61.5, 120, 0]), 3) == [61.5, 120.0, 0.0]

    def test_null_means_unreachable(self):
        assert parse_table_response(ok_payload([10, None]), 2) == [10.0, None]

    @pytest.mark.parametrize(
        "payload",
        [
            None,
            [],
            "Ok",
            {},
            {"code": "NoRoute", "durations": [[1, 2]]},
            {"code": "Ok"},
            {"code": "Ok", "durations": None},
            {"code": "Ok", "durations": []},
            {"code": "Ok", "durations": [[1, 2], [3, 4]]},
            {"code": "Ok", "durations": [1, 2]},
            {"code": "Ok", "durations": [[1]]},  # wrong length
            {"code": "Ok", "durations": [[1, 2, 3]]},
            {"code": "Ok", "durations": [[1, "2"]]},
            {"code": "Ok", "durations": [[1, True]]},
            {"code": "Ok", "durations": [[1, -5]]},
            {"code": "Ok", "durations": [[1, float("inf")]]},
            {"code": "Ok", "durations": [[1, float("nan")]]},
        ],
    )
    def test_malformed_rejected(self, payload):
        with pytest.raises(OsrmError):
            parse_table_response(payload, 2)


class TestTable:
    def test_returns_durations_and_requests_expected_url(self, settings):
        settings.OSRM_URL = "http://osrm.internal:5000/"
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json=ok_payload([5, 7.5]))

        assert table(ORIGIN, DESTS, client=client_with(handler)) == [5.0, 7.5]
        assert seen["url"].startswith("http://osrm.internal:5000/table/v1/driving/69.274300,")
        assert "//table" not in seen["url"]  # trailing slash of OSRM_URL is normalised

    @pytest.mark.parametrize("status", [400, 404, 429, 500, 503])
    def test_http_errors_become_osrm_error(self, status):
        client = client_with(lambda request: httpx.Response(status, json={"code": "Error"}))
        with pytest.raises(OsrmError):
            table(ORIGIN, DESTS, client=client)

    def test_timeout_becomes_osrm_error(self):
        def handler(request):
            raise httpx.ReadTimeout("slow", request=request)

        with pytest.raises(OsrmError):
            table(ORIGIN, DESTS, client=client_with(handler))

    def test_connection_error_becomes_osrm_error(self):
        def handler(request):
            raise httpx.ConnectError("refused", request=request)

        with pytest.raises(OsrmError):
            table(ORIGIN, DESTS, client=client_with(handler))

    def test_non_json_body_becomes_osrm_error(self):
        client = client_with(lambda request: httpx.Response(200, content=b"<html>oops</html>"))
        with pytest.raises(OsrmError):
            table(ORIGIN, DESTS, client=client)

    def test_oversized_body_rejected(self):
        body = json.dumps({"code": "Ok", "durations": [[0] * 10], "pad": "x" * 2_000_000})
        client = client_with(lambda request: httpx.Response(200, content=body.encode()))
        with pytest.raises(OsrmError):
            table(ORIGIN, DESTS, client=client)

    def test_malformed_payload_becomes_osrm_error(self):
        client = client_with(lambda request: httpx.Response(200, json={"code": "Ok"}))
        with pytest.raises(OsrmError):
            table(ORIGIN, DESTS, client=client)

    def test_error_message_and_logs_do_not_leak_the_url(self, settings, caplog):
        settings.OSRM_URL = "http://user:s3cret-token@osrm.internal:5000"

        def handler(request):
            raise httpx.ConnectError(f"cannot reach {request.url}", request=request)

        with caplog.at_level(logging.DEBUG), pytest.raises(OsrmError) as info:
            table(ORIGIN, DESTS, client=client_with(handler))
        assert "s3cret-token" not in str(info.value)
        assert "s3cret-token" not in caplog.text

    def test_default_client_uses_three_second_timeout(self):
        assert osrm_client.OSRM_TIMEOUT_SECONDS == 3.0

    def test_missing_setting_falls_back_to_localhost(self, settings):
        del settings.OSRM_URL
        assert osrm_client.get_base_url() == "http://localhost:5000"
