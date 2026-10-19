"""Small edge cases: system checks, the HTTP transport, address / size helpers, race fallbacks."""

import json
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

import httpx
import pytest
from django.db import IntegrityError

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.bookings.state import status_write_allowed
from apps.payments import checks, errors, reconcile, refunds, security, services
from apps.payments.models import Payment, PaymentStatus, Refund, RefundReason
from apps.payments.providers import http
from apps.payments.providers.base import PaymentProvider
from apps.payments.providers.click import ClickProvider
from apps.payments.providers.payme import PaymeProvider
from tests.payments import click_helpers as ch
from tests.payments import payme_helpers as ph
from tests.payments.factories import make_payment, make_refund, payme_id

pytestmark = pytest.mark.django_db


class TestSystemChecks:
    def test_missing_allowlist_is_a_deploy_warning(self, settings):
        settings.PAYMENTS_PROVIDER_IPS = []
        settings.PAYMENTS_PAYME_IPS = ["185.234.113.0/28"]
        settings.PAYMENTS_CLICK_IPS = []
        warnings = checks.check_provider_ip_allowlist(None)
        assert [w.id for w in warnings] == ["payments.W001"]
        assert "click" in warnings[0].msg and "payme" not in warnings[0].msg

    def test_complete_allowlist_is_silent(self, settings):
        settings.PAYMENTS_PROVIDER_IPS = ["203.0.113.0/24"]
        assert checks.check_provider_ip_allowlist(None) == []

    def test_sandbox_outside_debug_is_flagged(self, settings):
        settings.PAYMENTS_SANDBOX = True
        settings.DEBUG = False
        assert [w.id for w in checks.check_sandbox_off(None)] == ["payments.W002"]
        settings.DEBUG = True
        assert checks.check_sandbox_off(None) == []
        settings.PAYMENTS_SANDBOX = False
        settings.DEBUG = False
        assert checks.check_sandbox_off(None) == []


class TestHttpxTransport:
    def request(self):
        return http.HttpxTransport().request("DELETE", "https://x.test/a", headers={}, timeout=1)

    def test_json_object_is_parsed(self):
        response = httpx.Response(200, json={"error_code": 0})
        with mock.patch("httpx.request", return_value=response):
            assert self.request() == http.HttpResult(status=200, data={"error_code": 0})

    @pytest.mark.parametrize("body", [b"not json", b"[1, 2]", b""])
    def test_anything_but_an_object_has_no_data(self, body):
        with mock.patch("httpx.request", return_value=httpx.Response(502, content=body)):
            assert self.request() == http.HttpResult(status=502, data=None)

    def test_timeouts_and_network_errors_become_plain_codes_without_the_url(self):
        for error, code in (
            (httpx.ReadTimeout("https://secret.test/x"), "timeout"),
            (httpx.ConnectError("https://secret.test/x"), "network"),
        ):
            with mock.patch("httpx.request", side_effect=error):
                with pytest.raises(http.TransportError) as caught:
                    self.request()
            assert str(caught.value) == code
            assert caught.value.__cause__ is None and caught.value.__suppress_context__

    def test_redirects_are_not_followed(self):
        with mock.patch("httpx.request", return_value=httpx.Response(200, json={})) as sent:
            self.request()
        assert sent.call_args.kwargs["follow_redirects"] is False

    def test_the_default_transport_is_real_until_replaced(self):
        http.set_transport(None)
        assert isinstance(http.get_transport(), http.HttpxTransport)


class TestSecurityHelpers:
    def test_an_unreadable_address_is_never_allowed_when_a_list_exists(self, settings):
        settings.PAYMENTS_PAYME_IPS = ["185.234.113.0/28"]
        assert security.ip_allowed("payme", None) is False
        assert security.ip_allowed("click", None) is True  # no list for Click

    def test_ipv4_mapped_ipv6_is_the_same_address(self, settings):
        settings.PAYMENTS_PAYME_IPS = ["185.234.113.0/28"]
        request = SimpleNamespace(META={"REMOTE_ADDR": "::ffff:185.234.113.5"}, headers={})
        assert security.client_ip(request) == "185.234.113.5"
        assert security.ip_allowed("payme", "::ffff:185.234.113.5") is True
        assert security.ip_allowed("payme", "::ffff:198.51.100.9") is False

    def test_client_ip_is_none_for_garbage(self):
        request = SimpleNamespace(META={"REMOTE_ADDR": "garbage"}, headers={})
        assert security.client_ip(request) is None

    def test_body_longer_than_declared_is_refused(self, settings):
        settings.PAYMENTS_WEBHOOK_MAX_BODY_BYTES = 1024
        request = SimpleNamespace(
            META={"CONTENT_LENGTH": "5"}, _request=SimpleNamespace(body=b"x" * 2000)
        )
        with pytest.raises(security.PayloadTooLarge):
            security.read_body(request)

    def test_garbled_content_length_is_refused(self):
        request = SimpleNamespace(
            META={"CONTENT_LENGTH": "abc"}, _request=SimpleNamespace(body=b"")
        )
        with pytest.raises(security.PayloadTooLarge):
            security.read_body(request)

    def test_declared_length_alone_decides_before_reading(self, settings):
        settings.PAYMENTS_WEBHOOK_MAX_BODY_BYTES = 1024

        class Untouchable:
            @property
            def body(self):
                raise AssertionError("the body must not be read")

        request = SimpleNamespace(META={"CONTENT_LENGTH": "5000"}, _request=Untouchable())
        with pytest.raises(security.PayloadTooLarge):
            security.read_body(request)

    def test_provider_base_is_configured_by_default(self):
        class Dummy(PaymentProvider):
            code = "dummy"

            def build_payment_url(self, booking):
                return ""

            def handle_webhook(self, request, *, now):
                raise NotImplementedError

            def refund(self, payment, amount):
                raise NotImplementedError

        assert Dummy().is_configured() is True


class TestRegisterRaces:
    def test_losing_the_unique_race_to_the_same_booking_is_idempotent(self, booking, now):
        winner = make_payment(booking, external_id="w" * 24, status=PaymentStatus.PAID)
        with mock.patch.object(Payment.objects, "create", side_effect=IntegrityError):
            with (
                mock.patch.object(services.selectors, "booking_id_of_payment", return_value=None),
                mock.patch.object(services, "_locked_payment", return_value=None),
            ):
                result = services.register_transaction(
                    booking_id=booking.pk,
                    provider="payme",
                    external_id=winner.external_id,
                    amount=winner.amount,
                    now=now,
                )
        assert result.created is False and result.payment.pk == winner.pk

    def test_losing_it_to_another_booking_is_a_conflict(self, booking, make_pending, now):
        other = make_pending()
        winner = make_payment(other, external_id="w" * 24)
        with mock.patch.object(Payment.objects, "create", side_effect=IntegrityError):
            with (
                mock.patch.object(services.selectors, "booking_id_of_payment", return_value=None),
                mock.patch.object(services, "_locked_payment", return_value=None),
            ):
                with pytest.raises(errors.ConflictingTransaction):
                    services.register_transaction(
                        booking_id=booking.pk,
                        provider="payme",
                        external_id=winner.external_id,
                        amount=winner.amount,
                        now=now,
                    )


class TestAutoRefundGuards:
    def test_nothing_left_to_refund(self, booking, now):
        payment = make_payment(booking, status=PaymentStatus.PAID, refunded_amount="12000")
        assert refunds.create_auto_refund(payment, RefundReason.UNPAID_BOOKING, now=now) is None

    def test_existing_refund_is_returned(self, booking, now):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        first = refunds.create_auto_refund(payment, RefundReason.UNPAID_BOOKING, now=now)
        again = refunds.create_auto_refund(payment, RefundReason.UNPAID_BOOKING, now=now)
        assert again.pk == first.pk

    def test_a_refund_whose_booking_vanished_is_ignored(self, booking, now):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        refund = make_refund(payment)
        with mock.patch.object(
            refunds.booking_services, "lock_lot_and_booking", side_effect=refunds.NotFoundError
        ):
            assert refunds.process_refund(refund.pk, now=now).retry_in is None


class TestReconcileRaces:
    def test_a_payment_revived_while_waiting_is_left_alone(self, booking, now):
        payment = make_payment(booking)
        assert reconcile._cancel_orphan(payment.pk, now) is False
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.PENDING

    def test_unknown_ids_are_ignored(self, now):
        import uuid

        assert reconcile._cancel_orphan(uuid.uuid4(), now) is False
        assert reconcile._refund_orphan(uuid.uuid4(), now) is False

    def test_a_paid_booking_is_never_refunded_by_the_sweep(self, booking, now):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(
                status=S.CONFIRMED, paid_amount=booking.amount
            )
        assert reconcile._refund_orphan(payment.pk, now) is False
        assert not Refund.objects.exists()


class TestProviderOddities:
    def test_payme_create_for_a_non_uuid_order_is_31050(self, booking, now):
        params = {"id": payme_id(), "time": ph.ms(now), "amount": 100, "account": {"order_id": "x"}}
        result = PaymeProvider().handle_webhook(
            ph.request_for(ph.rpc("CreateTransaction", params)), now=now
        )
        assert result.payload["error"]["code"] == -31050

    def test_click_repeat_prepare_after_payment_and_after_cancel(self, booking, now):
        click = ClickProvider()
        first = click.handle_webhook(ch.request_for(ch.prepare_form(booking, now)), now=now)
        prepare_id = first.payload["merchant_prepare_id"]
        click.handle_webhook(ch.request_for(ch.complete_form(booking, now, prepare_id)), now=now)
        again = click.handle_webhook(ch.request_for(ch.prepare_form(booking, now)), now=now)
        assert again.payload["error"] == -4
        Payment.objects.update(status=PaymentStatus.CANCELLED)
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=S.PENDING_PAYMENT)
        cancelled = click.handle_webhook(ch.request_for(ch.prepare_form(booking, now)), now=now)
        assert cancelled.payload["error"] == -9

    def test_click_unconfigured_secret_refuses_everything(self, booking, now, settings):
        settings.CLICK_SECRET_KEY = ""
        form = ch.prepare_form(booking, now)
        result = ClickProvider().handle_webhook(ch.request_for(form), now=now)
        assert result.payload["error"] == -1

    def test_click_failure_code_that_is_not_a_number_is_still_a_cancel(self, booking, now):
        click = ClickProvider()
        first = click.handle_webhook(ch.request_for(ch.prepare_form(booking, now)), now=now)
        form = ch.complete_form(booking, now, first.payload["merchant_prepare_id"], error="boom")
        result = click.handle_webhook(ch.request_for(form), now=now)
        assert result.payload["error"] == -9
        assert Payment.objects.get().raw_state == {"click_error": -8}

    def test_click_unexpected_order_error_maps_to_a_request_error(self):
        mapped = ClickProvider._map_order_error(errors.PaymentError())
        assert mapped == -8

    def test_json_decoding_helper_survives_deep_nesting(self, now):
        result = PaymeProvider().handle_webhook(
            ph.request_for(None, raw=json.dumps({"a": [[[1]]]}).encode()), now=now
        )
        assert result.payload["error"]["code"] == -32600


def test_expired_hold_timedelta_sanity():
    assert timedelta(minutes=5) < timedelta(minutes=10)
    assert Decimal("12000.00") == Decimal("12000")


class TestEventRetention:
    def make(self, age_days, count=1):
        from django.utils import timezone

        from apps.payments.models import WebhookEvent

        rows = [
            WebhookEvent.objects.create(provider="payme", method="X", result_code=0)
            for _ in range(count)
        ]
        WebhookEvent.objects.filter(pk__in=[r.pk for r in rows]).update(
            created_at=timezone.now() - timedelta(days=age_days)
        )

    def test_old_events_are_purged_in_batches_and_new_ones_stay(self, settings):
        from apps.payments import events
        from apps.payments.models import WebhookEvent

        self.make(100, count=7)
        self.make(10, count=3)
        with mock.patch.object(events, "PURGE_BATCH", 2):
            deleted = events.purge()
        assert deleted == 7
        assert WebhookEvent.objects.count() == 3

    def test_retention_is_configurable(self, settings):
        from apps.payments import events
        from apps.payments.models import WebhookEvent

        settings.PAYMENTS_EVENT_RETENTION_DAYS = 5
        self.make(10)
        assert events.purge() == 1
        assert WebhookEvent.objects.count() == 0

    def test_the_task_and_the_beat_entry_exist(self):
        from apps.payments import tasks
        from config.celery import CELERY_BEAT_SCHEDULE

        assert tasks.purge_webhook_events.run() == 0
        entry = CELERY_BEAT_SCHEDULE["payments-purge-webhook-events"]
        assert entry["task"] == "payments.purge_webhook_events"
        assert entry["schedule"] == 86400.0 and entry["options"]["expires"] > 0


class TestEnqueueFailure:
    def test_a_down_broker_after_commit_does_not_break_or_lose_the_refund(
        self, booking, now, django_capture_on_commit_callbacks, caplog
    ):
        from apps.bookings import services as booking_services
        from apps.payments import tasks

        payment = make_payment(booking, status=PaymentStatus.PAID, performed_at=now)
        Booking.objects.filter(pk=booking.pk).update(paid_amount=booking.amount)
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=S.CONFIRMED)
        with mock.patch.object(tasks.send_refund, "apply_async", side_effect=OSError("broker")):
            with django_capture_on_commit_callbacks(execute=True):
                booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        refund = Refund.objects.get(payment=payment)
        assert refund.status == "PENDING"  # committed; retry_failed_webhooks will queue it
        assert any("could not enqueue" in r.getMessage() for r in caplog.records)


class TestClickProviderRef:
    def test_the_click_payment_id_is_learned_at_complete_when_prepare_lacked_it(self, booking, now):
        click = ClickProvider()
        first = click.handle_webhook(
            ch.request_for(ch.prepare_form(booking, now, click_paydoc_id="")), now=now
        )
        assert Payment.objects.get().provider_ref == ""
        form = ch.complete_form(
            booking, now, first.payload["merchant_prepare_id"], click_paydoc_id="777"
        )
        assert click.handle_webhook(ch.request_for(form), now=now).payload["error"] == 0
        assert Payment.objects.get().provider_ref == "777"

    def test_an_existing_payment_id_is_never_overwritten(self, booking, now):
        click = ClickProvider()
        first = click.handle_webhook(ch.request_for(ch.prepare_form(booking, now)), now=now)
        form = ch.complete_form(
            booking, now, first.payload["merchant_prepare_id"], click_paydoc_id="999"
        )
        click.handle_webhook(ch.request_for(form), now=now)
        assert Payment.objects.get().provider_ref == "555"


class TestCompleteAfterTheSweeperCancelled:
    def test_click_complete_after_the_orphan_sweep_is_minus_9_and_takes_no_money(
        self, booking, now
    ):
        from apps.payments import reconcile

        click = ClickProvider()
        first = click.handle_webhook(ch.request_for(ch.prepare_form(booking, now)), now=now)
        Payment.objects.update(created_at=now - timedelta(hours=2))
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=S.EXPIRED)
        reconcile.run(now=now)
        assert Payment.objects.get().status == PaymentStatus.CANCELLED
        form = ch.complete_form(booking, now, first.payload["merchant_prepare_id"])
        result = click.handle_webhook(ch.request_for(form), now=now)
        assert result.payload["error"] == -9
        assert not Refund.objects.exists()


class TestSentryScrubbing:
    def test_payment_request_bodies_and_credentials_never_leave(self):
        from config.sentry import before_send

        event = {
            "request": {
                "url": "https://api.parkbor.uz/api/v1/payments/click/webhook",
                "data": "sign_string=abc&click_trans_id=1",
                "query_string": "x=1",
                "headers": {"Authorization": "Basic c2VjcmV0", "Content-Type": "text/json"},
            },
            "extra": {"sign_string": "abc"},
        }
        cleaned = before_send(event, None)
        assert "data" not in cleaned["request"] and "query_string" not in cleaned["request"]
        assert cleaned["request"]["headers"]["Authorization"] == "<redacted>"
        assert cleaned["request"]["headers"]["Content-Type"] == "text/json"
        assert cleaned["extra"]["sign_string"] == "<redacted>"

    def test_other_requests_keep_their_data(self):
        from config.sentry import before_send

        event = {"request": {"url": "https://api.parkbor.uz/api/v1/bookings", "data": {"a": 1}}}
        assert before_send(event, None)["request"]["data"] == {"a": 1}


class TestSentrySecrets:
    def test_provider_keys_are_masked_wherever_they_appear(self, settings):
        from config.sentry import scrub

        settings.PAYME_KEY = "payme-key-0123456789-abcdefghij"
        settings.CLICK_SECRET_KEY = "click-secret-key-01"
        text = f"boom {settings.PAYME_KEY} and {settings.CLICK_SECRET_KEY}"
        assert scrub(text) == "boom <redacted> and <redacted>"

    def test_short_values_are_not_blanked_out(self, settings):
        from config.sentry import scrub

        settings.CLICK_SECRET_KEY = "a"
        assert scrub("a banana") == "a banana"

    def test_local_variables_are_not_sent(self, monkeypatch):
        import sys

        from config.sentry import init_sentry

        fake = mock.MagicMock()  # sentry-sdk is a production-only dependency
        monkeypatch.setitem(sys.modules, "sentry_sdk", fake)
        init_sentry("https://k@example.invalid/1")
        assert fake.init.call_args.kwargs["include_local_variables"] is False


def test_payment_hooks_live_behind_services():
    """payment_hooks is imported by services at its END and needs it: always import `services`."""
    from apps.bookings import payment_hooks, services

    assert services.confirm_locked is payment_hooks.confirm_locked
    assert (
        "import ``services``" in payment_hooks.__doc__
        or "import `services`" in payment_hooks.__doc__
    )
