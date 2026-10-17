"""Expo Push API client: batching, response analysis, payload limits, no secrets in logs."""

import json
import logging

import httpx
import pytest

from apps.notifications.channels import expo_push
from apps.notifications.channels.expo_push import PushMessage, PushOutcome

TOKEN = "ExponentPushToken[abc_DEF-123]"


def message(token=TOKEN, title="Title", body="Body", url="habi://booking/x"):
    return PushMessage(token=token, title=title, body=body, data={"url": url})


@pytest.fixture
def http(monkeypatch):
    """Install a mock transport; the test sets ``http.handler``."""

    class Holder:
        handler = None
        requests: list[httpx.Request] = []

    holder = Holder()
    holder.requests = []

    def route(request):
        holder.requests.append(request)
        return holder.handler(request)

    client = httpx.Client(transport=httpx.MockTransport(route))
    expo_push.set_http_client(client)
    yield holder
    expo_push.set_http_client(None)


def ok(n=1):
    return httpx.Response(200, json={"data": [{"status": "ok", "id": f"id-{i}"} for i in range(n)]})


def test_token_format():
    assert expo_push.valid_token(TOKEN)
    assert expo_push.valid_token("ExpoPushToken[xyz]")
    for bad in ("", "token", "ExponentPushToken[]", "ExponentPushToken[a b]", None, 5):
        assert not expo_push.valid_token(bad)


def test_a_message_is_sent_to_the_expo_endpoint(http, settings):
    http.handler = lambda request: ok()
    [result] = expo_push.send([message()])
    assert result.outcome is PushOutcome.OK and result.ticket_id == "id-0"
    request = http.requests[0]
    assert str(request.url) == "https://exp.host/--/api/v2/push/send"
    body = json.loads(request.content)
    assert body == [
        {
            "to": TOKEN,
            "title": "Title",
            "body": "Body",
            "data": {"url": "habi://booking/x"},
            "sound": "default",
            "priority": "high",
        }
    ]


def test_authorization_header_only_when_an_access_token_is_configured(http, settings):
    http.handler = lambda request: ok()
    settings.EXPO_ACCESS_TOKEN = ""
    expo_push.send([message()])
    assert "authorization" not in http.requests[-1].headers
    settings.EXPO_ACCESS_TOKEN = "secret-access-token"
    expo_push.send([message()])
    assert http.requests[-1].headers["authorization"] == "Bearer secret-access-token"


def test_more_than_100_messages_are_sent_in_batches(http):
    http.handler = lambda request: ok(len(json.loads(request.content)))
    results = expo_push.send([message() for _ in range(250)])
    assert [len(json.loads(r.content)) for r in http.requests] == [100, 100, 50]
    assert len(results) == 250 and all(r.outcome is PushOutcome.OK for r in results)


def test_results_stay_aligned_with_the_input_when_some_are_invalid(http):
    http.handler = lambda request: ok(len(json.loads(request.content)))
    results = expo_push.send([message(), message(token="garbage"), message()])
    assert [r.outcome for r in results] == [
        PushOutcome.OK,
        PushOutcome.INVALID_TOKEN,
        PushOutcome.OK,
    ]
    assert len(json.loads(http.requests[0].content)) == 2  # the bad one never left the process


def test_device_not_registered_marks_the_token_invalid(http):
    http.handler = lambda request: httpx.Response(
        200,
        json={
            "data": [
                {
                    "status": "error",
                    "message": "not registered",
                    "details": {"error": "DeviceNotRegistered"},
                }
            ]
        },
    )
    [result] = expo_push.send([message()])
    assert result.outcome is PushOutcome.INVALID_TOKEN
    assert result.error == "DeviceNotRegistered"


@pytest.mark.parametrize(
    ("error", "outcome"),
    [
        ("MessageRateExceeded", PushOutcome.RETRY),
        ("SomethingNew", PushOutcome.RETRY),
        ("MessageTooBig", PushOutcome.FAILED),
        ("InvalidCredentials", PushOutcome.FAILED),
    ],
)
def test_item_errors_are_classified(http, error, outcome):
    http.handler = lambda request: httpx.Response(
        200, json={"data": [{"status": "error", "details": {"error": error}}]}
    )
    [result] = expo_push.send([message()])
    assert result.outcome is outcome and result.error == error


@pytest.mark.parametrize(
    ("response", "outcome"),
    [
        (httpx.Response(429, headers={"Retry-After": "7"}), PushOutcome.RETRY),
        (httpx.Response(500), PushOutcome.RETRY),
        (httpx.Response(503), PushOutcome.RETRY),
        (httpx.Response(400, json={"errors": [{"code": "VALIDATION_ERROR"}]}), PushOutcome.FAILED),
        (httpx.Response(401), PushOutcome.FAILED),
        (httpx.Response(200, text="<html>"), PushOutcome.RETRY),
        (httpx.Response(200, json={"data": []}), PushOutcome.RETRY),  # wrong length
        (httpx.Response(200, json={"oops": 1}), PushOutcome.RETRY),
    ],
)
def test_http_level_failures_are_classified(http, response, outcome):
    http.handler = lambda request: response
    [result] = expo_push.send([message()])
    assert result.outcome is outcome


def test_retry_after_is_reported(http):
    http.handler = lambda request: httpx.Response(429, headers={"Retry-After": "7"})
    [result] = expo_push.send([message()])
    assert result.retry_after == 7


def test_network_errors_are_retried_without_leaking_details(http, caplog):
    def boom(request):
        raise httpx.ConnectError("connection refused to https://exp.host/?secret=1")

    http.handler = boom
    with caplog.at_level(logging.DEBUG):
        [result] = expo_push.send([message()])
    assert result.outcome is PushOutcome.RETRY and result.error == "network_error"
    assert "secret=1" not in caplog.text


def test_a_failing_batch_does_not_stop_the_others(http):
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(500)
        return ok(len(json.loads(request.content)))

    http.handler = handler
    results = expo_push.send([message() for _ in range(150)])
    assert [r.outcome for r in results[:100]] == [PushOutcome.RETRY] * 100
    assert [r.outcome for r in results[100:]] == [PushOutcome.OK] * 50


def test_oversized_payload_is_refused_locally(http):
    http.handler = lambda request: ok()
    [result] = expo_push.send([message(body="x" * 5000)])
    assert result.outcome is PushOutcome.FAILED and result.error == "payload_too_large"
    assert http.requests == []


def test_the_payload_limit_counts_bytes_not_characters(http):
    http.handler = lambda request: ok()
    [result] = expo_push.send([message(body="€" * 1500)])  # 4500 bytes in UTF-8
    assert result.outcome is PushOutcome.FAILED


def test_tokens_and_secrets_are_never_logged(http, settings, caplog):
    settings.EXPO_ACCESS_TOKEN = "secret-access-token"
    http.handler = lambda request: httpx.Response(500)
    with caplog.at_level(logging.DEBUG):
        expo_push.send([message()])
    assert TOKEN not in caplog.text
    assert "secret-access-token" not in caplog.text
    assert "abc_DEF" not in caplog.text


# --- receipts ------------------------------------------------------------------------------


def test_receipts_report_unregistered_devices(http):
    http.handler = lambda request: httpx.Response(
        200,
        json={
            "data": {
                "a": {"status": "ok"},
                "b": {"status": "error", "details": {"error": "DeviceNotRegistered"}},
                "c": {"status": "error", "details": {"error": "MessageRateExceeded"}},
            }
        },
    )
    receipts = expo_push.get_receipts(["a", "b", "c", "d"])
    assert receipts["a"].outcome is PushOutcome.OK
    assert receipts["b"].outcome is PushOutcome.INVALID_TOKEN
    assert receipts["c"].outcome is PushOutcome.RETRY
    assert "d" not in receipts  # not ready yet
    assert json.loads(http.requests[0].content) == {"ids": ["a", "b", "c", "d"]}


def test_receipt_failures_return_nothing(http):
    http.handler = lambda request: httpx.Response(500)
    assert expo_push.get_receipts(["a"]) == {}
    http.handler = lambda request: httpx.Response(200, text="nope")
    assert expo_push.get_receipts(["a"]) == {}
