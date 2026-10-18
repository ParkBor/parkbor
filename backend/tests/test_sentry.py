import sys
import types

import pytest

from config import sentry

TOKEN = "123456:ABC-def_GHI"


def test_scrub_masks_bot_api_urls():
    text = f"POST https://api.telegram.org/bot{TOKEN}/sendMessage failed"
    cleaned = sentry.scrub(text)
    assert TOKEN not in cleaned
    assert "api.telegram.org/bot<redacted>/sendMessage" in cleaned


def test_scrub_masks_literal_configured_token(settings):
    settings.TELEGRAM_BOT_TOKEN = "999:SECRETVALUE"
    assert "SECRETVALUE" not in sentry.scrub("leaked 999:SECRETVALUE here")


def test_scrub_leaves_clean_text_alone():
    assert sentry.scrub("nothing to see") == "nothing to see"


def test_before_send_scrubs_nested_event():
    event = {
        "message": f"/bot{TOKEN}/x",
        "exception": {"values": [{"value": f"url=/bot{TOKEN}/getUpdates"}]},
        "request": {"url": f"https://api.telegram.org/bot{TOKEN}/y", "n": 3},
        "tags": [f"/bot{TOKEN}/z", 5],
    }
    cleaned = sentry.before_send(event, {})
    assert TOKEN not in repr(cleaned)
    assert cleaned["request"]["n"] == 3


def test_before_breadcrumb_scrubs_http_breadcrumb():
    crumb = {"category": "httplib", "data": {"url": f"https://api.telegram.org/bot{TOKEN}/a"}}
    assert TOKEN not in repr(sentry.before_breadcrumb(crumb, {}))


def test_init_sentry_does_nothing_without_dsn(monkeypatch):
    fake = types.SimpleNamespace(init=lambda **kw: pytest.fail("must not be called"))
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)
    assert sentry.init_sentry("") is False


def test_init_sentry_registers_scrubbers_and_disables_pii(monkeypatch):
    captured = {}
    fake = types.SimpleNamespace(init=lambda **kw: captured.update(kw))
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)
    assert sentry.init_sentry("https://k@o.ingest.sentry.io/1") is True
    assert captured["before_send"] is sentry.before_send
    assert captured["before_breadcrumb"] is sentry.before_breadcrumb
    assert captured["send_default_pii"] is False


def test_init_sentry_wires_environment_release_and_never_sends_bodies(monkeypatch):
    captured = {}
    fake = types.SimpleNamespace(init=lambda **kw: captured.update(kw))
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "staging")
    monkeypatch.setenv("SENTRY_RELEASE", "habi-backend@abc123")
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "0.25")
    sentry.init_sentry("https://k@o.ingest.sentry.io/1")
    assert captured["environment"] == "staging"
    assert captured["release"] == "habi-backend@abc123"
    assert captured["traces_sample_rate"] == 0.25
    assert captured["max_request_body_size"] == "never"


@pytest.mark.parametrize("raw", ["", "abc", "-1", "7"])
def test_init_sentry_ignores_a_bad_trace_rate(monkeypatch, raw):
    captured = {}
    fake = types.SimpleNamespace(init=lambda **kw: captured.update(kw))
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", raw)
    sentry.init_sentry("https://k@o.ingest.sentry.io/1")
    assert captured["traces_sample_rate"] == 0.0
    assert captured["release"] is None


def test_a_bare_query_string_ticket_is_masked():
    assert "abc123" not in sentry.scrub("ticket=abc123&x=1")


def test_scan_request_bodies_and_qr_tokens_never_leave():
    event = {
        "request": {
            "url": "https://api.habi.uz/api/v1/operator/checkin",
            "data": {"qr_token": "SECRET-QR"},
            "query_string": "x=1",
        },
        "extra": {"qr_token": "SECRET-QR", "other": "kept"},
    }

    cleaned = sentry.before_send(event, {})

    assert "data" not in cleaned["request"]
    assert "SECRET-QR" not in repr(cleaned)
    assert cleaned["extra"]["other"] == "kept"


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/operator/checkin",
        "/api/v1/operator/checkout/",
        "/api/v1/me/operator-invites/accept",
    ],
)
def test_bodies_of_secret_carrying_endpoints_are_dropped_by_exact_path(path):
    event = {"request": {"url": f"https://api.habi.uz{path}?x=1", "data": {"code": "SECRET"}}}

    assert "data" not in sentry.before_send(event, {})["request"]


def test_other_paths_that_merely_look_similar_keep_their_bodies():
    event = {
        "request": {
            "url": "https://api.habi.uz/api/v1/bookings/operator/checkin",
            "data": {"a": 1},
        }
    }

    assert sentry.before_send(event, {})["request"]["data"] == {"a": 1}


# --- WebSocket tickets and Expo push credentials (Step 10a) -----------------------------------


def test_a_ws_ticket_in_a_url_is_masked():
    cleaned = sentry.scrub("GET /ws/availability/?ticket=abcDEF_123-xyz&x=1 failed")
    assert "abcDEF" not in cleaned
    assert "ticket=<redacted>&x=1" in cleaned


def test_a_ws_ticket_in_the_event_is_removed_everywhere():
    event = {
        "request": {
            "url": "https://api.habi.uz/ws/availability/?ticket=TICKETVALUE0123456789",
            "query_string": "ticket=TICKETVALUE0123456789",
            "data": {"type": "auth", "ticket": "TICKETVALUE0123456789"},
        },
        "extra": {"ticket": "TICKETVALUE0123456789"},
        "breadcrumbs": [{"message": "GET /ws/availability/?ticket=TICKETVALUE0123456789"}],
    }
    cleaned = sentry.before_send(event, {})
    assert "TICKETVALUE" not in repr(cleaned)


def test_the_ticket_endpoint_response_is_not_reported():
    event = {"request": {"url": "https://api.habi.uz/api/v1/ws/ticket", "data": {"x": 1}}}
    assert "data" not in sentry.before_send(event, {})["request"]


@pytest.mark.parametrize("token", ["ExponentPushToken[abc_DEF-123]", "ExpoPushToken[xyz]"])
def test_expo_push_tokens_are_masked(token):
    cleaned = sentry.scrub(f"push to {token} failed")
    assert token not in cleaned and "<expo-token>" in cleaned


def test_the_expo_access_token_is_masked(settings):
    settings.EXPO_ACCESS_TOKEN = "expo-access-secret-value"
    assert "expo-access-secret-value" not in sentry.scrub("Bearer expo-access-secret-value")
