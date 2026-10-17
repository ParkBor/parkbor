"""The two webhook endpoints, end to end through Django (auth, IP, size, throttle, audit log)."""

import json
import logging
import os
from datetime import timedelta
from urllib.parse import urlencode

import pytest
from django.core.management import call_command
from django.test import Client
from rest_framework.throttling import SimpleRateThrottle

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.payments.models import Payment, PaymentStatus, WebhookEvent
from tests.payments import click_helpers as ch
from tests.payments import payme_helpers as ph
from tests.payments.factories import payme_id

pytestmark = pytest.mark.django_db

PAYME_URL = "/api/v1/payments/payme/webhook"
CLICK_URL = "/api/v1/payments/click/webhook"
PAYME_IP = "185.234.113.5"


@pytest.fixture
def web():
    # CSRF enforcement ON: the webhooks must not depend on a CSRF token (JWT-only API).
    return Client(enforce_csrf_checks=True)


def payme_post(web, body, *, auth=None, ip=PAYME_IP, raw=None, **extra):
    payload = raw if raw is not None else json.dumps(body)
    headers = {"HTTP_AUTHORIZATION": ph.basic() if auth is None else auth}
    if auth == "":
        headers = {}
    return web.post(
        PAYME_URL,
        data=payload,
        content_type="text/json; charset=UTF-8",
        REMOTE_ADDR=ip,
        **headers,
        **extra,
    )


def click_post(web, form, *, ip="203.0.113.7", **extra):
    return web.post(
        CLICK_URL,
        data=urlencode(form),
        content_type="application/x-www-form-urlencoded",
        REMOTE_ADDR=ip,
        **extra,
    )


def check_perform(booking):
    return ph.rpc(
        "CheckPerformTransaction", {"amount": ph.tiyin(booking), "account": ph.account(booking)}
    )


class TestPayme:
    def test_answers_json_rpc(self, web, booking):
        response = payme_post(web, check_perform(booking))
        assert response.status_code == 200
        assert response.json() == {"result": {"allow": True}, "id": 1}

    def test_does_not_need_a_csrf_token_or_jwt(self, web, booking):
        response = payme_post(web, check_perform(booking), HTTP_COOKIE="csrftoken=bad")
        assert response.status_code == 200

    def test_bad_credentials_are_a_protocol_error_not_an_http_error(self, web, booking):
        response = payme_post(web, check_perform(booking), auth=ph.basic("Paycom", "wrong"))
        assert response.status_code == 200
        assert response.json()["error"]["code"] == -32504

    def test_missing_credentials(self, web, booking):
        response = payme_post(web, check_perform(booking), auth="")
        assert response.json()["error"]["code"] == -32504

    def test_bad_json_is_a_protocol_error(self, web):
        response = payme_post(web, None, raw="{broken")
        assert response.status_code == 200
        assert response.json()["error"]["code"] == -32700

    def test_empty_body(self, web):
        assert payme_post(web, None, raw="").json()["error"]["code"] == -32700

    def test_get_is_32300(self, web):
        response = web.get(PAYME_URL, REMOTE_ADDR=PAYME_IP)
        assert response.status_code == 200
        assert response.json()["error"]["code"] == -32300

    def test_full_payment_through_http(self, web, booking, now):
        tx = payme_id()
        body = ph.rpc(
            "CreateTransaction",
            {
                "id": tx,
                "time": ph.ms(now),
                "amount": ph.tiyin(booking),
                "account": ph.account(booking),
            },
        )
        assert payme_post(web, body).json()["result"]["state"] == 1
        perform = payme_post(web, ph.rpc("PerformTransaction", {"id": tx})).json()
        assert perform["result"]["state"] == 2
        booking.refresh_from_db()
        assert booking.status == S.CONFIRMED

    def test_responses_are_not_cached(self, web, booking):
        assert "no-store" in payme_post(web, check_perform(booking))["Cache-Control"]


class TestClick:
    def test_prepare_and_complete_through_http(self, web, booking, now):
        prepared = click_post(web, ch.prepare_form(booking, now)).json()
        assert prepared["error"] == 0
        done = click_post(
            web, ch.complete_form(booking, now, prepared["merchant_prepare_id"])
        ).json()
        assert done["error"] == 0
        booking.refresh_from_db()
        assert booking.status == S.CONFIRMED

    def test_does_not_need_a_csrf_token(self, web, booking, now):
        assert click_post(web, ch.prepare_form(booking, now)).status_code == 200

    def test_bad_signature_is_a_protocol_error(self, web, booking, now):
        form = ch.prepare_form(booking, now, sign_string="0" * 32)
        response = click_post(web, form)
        assert response.status_code == 200 and response.json()["error"] == -1

    def test_json_body_is_not_a_form(self, web, booking, now):
        response = web.post(
            CLICK_URL,
            data=json.dumps(ch.prepare_form(booking, now)),
            content_type="application/json",
            REMOTE_ADDR="203.0.113.7",
        )
        assert response.status_code == 200 and response.json()["error"] == -8

    def test_get_is_not_allowed(self, web):
        assert web.get(CLICK_URL).status_code == 405


class TestIpAllowlist:
    def test_empty_list_means_no_check(self, web, booking):
        assert payme_post(web, check_perform(booking), ip="198.51.100.9").status_code == 200

    def test_listed_address_and_network_are_allowed(self, web, booking, settings):
        settings.PAYMENTS_PAYME_IPS = ["185.234.113.0/28", "198.51.100.77"]
        assert payme_post(web, check_perform(booking), ip="185.234.113.9").status_code == 200
        assert payme_post(web, check_perform(booking), ip="198.51.100.77").status_code == 200

    def test_other_addresses_are_refused_before_anything_runs(self, web, booking, settings):
        settings.PAYMENTS_PAYME_IPS = ["185.234.113.0/28"]
        response = payme_post(web, check_perform(booking), ip="198.51.100.9")
        assert response.status_code == 403
        assert response.json()["code"] == "permission_denied"
        assert not WebhookEvent.objects.exists()

    def test_shared_list_applies_to_both_providers(self, web, booking, now, settings):
        settings.PAYMENTS_PROVIDER_IPS = ["203.0.113.0/24"]
        assert click_post(web, ch.prepare_form(booking, now), ip="203.0.113.7").status_code == 200
        assert click_post(web, ch.prepare_form(booking, now), ip="198.51.100.9").status_code == 403
        assert payme_post(web, check_perform(booking), ip="198.51.100.9").status_code == 403

    def test_provider_specific_list_wins_over_the_shared_one(self, web, booking, settings):
        settings.PAYMENTS_PROVIDER_IPS = ["203.0.113.0/24"]
        settings.PAYMENTS_PAYME_IPS = ["185.234.113.0/28"]
        assert payme_post(web, check_perform(booking), ip="185.234.113.3").status_code == 200
        assert payme_post(web, check_perform(booking), ip="203.0.113.7").status_code == 403

    def test_forwarded_for_header_cannot_spoof_the_address(self, web, booking, settings):
        settings.PAYMENTS_PAYME_IPS = ["185.234.113.0/28"]
        response = payme_post(
            web, check_perform(booking), ip="198.51.100.9", HTTP_X_FORWARDED_FOR="185.234.113.5"
        )
        assert response.status_code == 403

    def test_ipv6_clients_are_handled(self, web, booking, settings):
        settings.PAYMENTS_PAYME_IPS = ["185.234.113.0/28"]
        assert payme_post(web, check_perform(booking), ip="2001:db8::1").status_code == 403


class TestBodyLimit:
    def test_body_over_the_limit_is_413_and_never_parsed(self, web, settings):
        settings.PAYMENTS_WEBHOOK_MAX_BODY_BYTES = 1024
        response = payme_post(web, None, raw="x" * 1025)
        assert response.status_code == 413
        assert response.json()["code"] == "payload_too_large"

    def test_body_at_the_limit_is_processed(self, web, settings):
        settings.PAYMENTS_WEBHOOK_MAX_BODY_BYTES = 1024
        response = payme_post(web, None, raw=" " * 1024)
        assert response.status_code == 200  # parse error, but it was read

    def test_click_body_over_the_limit(self, web, settings):
        settings.PAYMENTS_WEBHOOK_MAX_BODY_BYTES = 1024
        response = click_post(web, {"a": "x" * 2000})
        assert response.status_code == 413

    def test_huge_declared_length_is_refused_without_reading(self, web):
        response = web.post(
            PAYME_URL,
            data="{}",
            content_type="text/json",
            CONTENT_LENGTH="999999999",
            REMOTE_ADDR=PAYME_IP,
        )
        assert response.status_code == 413


class TestThrottle:
    def test_per_ip_limit(self, web, booking, monkeypatch):
        monkeypatch.setattr(
            SimpleRateThrottle,
            "THROTTLE_RATES",
            {**SimpleRateThrottle.THROTTLE_RATES, "payment_webhook": "3/min"},
        )
        codes = [payme_post(web, check_perform(booking)).status_code for _ in range(5)]
        assert codes == [200, 200, 200, 429, 429]

    def test_limit_is_per_address(self, web, booking, monkeypatch):
        monkeypatch.setattr(
            SimpleRateThrottle,
            "THROTTLE_RATES",
            {**SimpleRateThrottle.THROTTLE_RATES, "payment_webhook": "1/min"},
        )
        assert payme_post(web, check_perform(booking), ip="185.234.113.1").status_code == 200
        assert payme_post(web, check_perform(booking), ip="185.234.113.2").status_code == 200

    def test_default_rate_is_wide(self):
        from django.conf import settings

        assert settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["payment_webhook"] == "600/min"


class TestAuditLog:
    def test_every_callback_leaves_a_safe_record(self, web, booking, now):
        tx = payme_id()
        body = ph.rpc(
            "CreateTransaction",
            {
                "id": tx,
                "time": ph.ms(now),
                "amount": ph.tiyin(booking),
                "account": ph.account(booking),
            },
        )
        payme_post(web, body)
        event = WebhookEvent.objects.get()
        assert (event.provider, event.method, event.external_id, event.booking_id) == (
            "payme",
            "CreateTransaction",
            tx,
            booking.pk,
        )
        assert event.result_code == 0
        assert event.remote_ip == PAYME_IP
        assert event.duration_ms >= 0

    def test_unauthenticated_requests_leave_no_database_row(self, web, booking, now):
        """Anyone on the internet can send garbage: only authenticated callbacks are stored."""
        payme_post(web, check_perform(booking), auth=ph.basic("Paycom", "wrong"))
        payme_post(web, check_perform(booking), auth="")
        payme_post(web, None, raw="{broken", auth="Basic x")
        click_post(web, ch.prepare_form(booking, now, sign_string="0" * 32))
        click_post(web, {"junk": "1"})
        click_post(web, ch.prepare_form(booking, now, action="9"))
        assert not WebhookEvent.objects.exists()

    def test_authenticated_failures_are_recorded_with_their_code(self, web, booking, now):
        bad = ph.rpc("CheckPerformTransaction", {"amount": 1, "account": ph.account(booking)})
        payme_post(web, bad)
        click_post(web, ch.prepare_form(booking, now, amount="1"))
        assert sorted(WebhookEvent.objects.values_list("result_code", flat=True)) == [-31001, -2]

    def test_click_does_not_echo_unsigned_input(self, web, booking, now):
        form = ch.prepare_form(booking, now, sign_string="0" * 32, click_trans_id="<script>")
        body = click_post(web, form).json()
        assert body == {"error": -1, "error_note": "SIGN CHECK FAILED!"}
        missing = click_post(
            web, {"click_trans_id": "<b>x</b>", "merchant_trans_id": "evil"}
        ).json()
        assert "click_trans_id" not in missing and "merchant_trans_id" not in missing

    def test_click_callbacks_are_recorded(self, web, booking, now):
        click_post(web, ch.prepare_form(booking, now))
        event = WebhookEvent.objects.get()
        assert (event.provider, event.method, event.external_id) == ("click", "prepare", "1001")

    def test_no_secret_signature_or_body_is_stored(self, web, booking, now):
        click_post(web, ch.prepare_form(booking, now))
        payme_post(web, check_perform(booking))
        stored = " ".join(
            str(value) for event in WebhookEvent.objects.all() for value in event.__dict__.values()
        )
        form = ch.prepare_form(booking, now)
        assert form["sign_string"] not in stored
        assert ph.KEY not in stored and ch.SECRET not in stored
        assert "Basic" not in stored
        assert "amount" not in stored

    def test_a_logging_failure_does_not_break_the_answer(self, web, booking, monkeypatch):
        def broken(*args, **kwargs):
            raise RuntimeError("db down")

        monkeypatch.setattr(WebhookEvent.objects, "create", broken)
        assert payme_post(web, check_perform(booking)).status_code == 200

    def test_nothing_sensitive_reaches_the_logs(self, web, booking, now, caplog):
        caplog.set_level(logging.DEBUG)
        marker = "SECRET-MARKER-xyz"
        payme_post(web, check_perform(booking), auth=ph.basic("Paycom", marker))
        payme_post(web, None, raw=json.dumps({"method": "X", "note": marker}))
        click_post(web, ch.prepare_form(booking, now, sign_string=marker))
        click_post(web, ch.prepare_form(booking, now))
        for needle in (marker, ph.KEY, ch.SECRET, ch.prepare_form(booking, now)["sign_string"]):
            assert needle not in caplog.text


class TestWeirdInput:
    @pytest.mark.parametrize(
        "raw", ["null", "[]", '"x"', "1", "{", '{"method": null}', "\x00" * 50, "💥" * 100]
    )
    def test_payme_never_returns_500(self, web, raw):
        response = payme_post(web, None, raw=raw)
        assert response.status_code == 200
        assert "error" in response.json()

    @pytest.mark.parametrize("raw", ["", "a=1&a=2", "%ZZ", "x" * 500, "\x00=\x00", "💥=💥"])
    def test_click_never_returns_500(self, web, raw):
        response = web.post(
            CLICK_URL,
            data=raw,
            content_type="application/x-www-form-urlencoded",
            REMOTE_ADDR="203.0.113.7",
        )
        assert response.status_code in (200, 413)
        if response.status_code == 200:
            assert response.json()["error"] == -8


class TestSchema:
    def test_openapi_has_no_warnings_and_documents_both_endpoints(self, tmp_path):
        out = tmp_path / "schema.json"
        call_command(
            "spectacular", "--fail-on-warn", "--format", "openapi-json", "--file", str(out)
        )
        paths = json.loads(out.read_text(encoding="utf-8"))["paths"]
        assert "/api/v1/payments/payme/webhook" in paths
        assert "/api/v1/payments/click/webhook" in paths
        assert list(paths["/api/v1/payments/payme/webhook"]) == ["post"]
        assert os.path.exists(out)


def test_booking_status_untouched_by_a_rejected_request(web, booking):
    payme_post(web, check_perform(booking), auth=ph.basic("x", "y"))
    booking.refresh_from_db()
    assert booking.status == S.PENDING_PAYMENT
    assert Booking.objects.count() == 1
    assert not Payment.objects.exists()
    assert PaymentStatus.PENDING == "PENDING"
    assert timedelta(0) == timedelta()
