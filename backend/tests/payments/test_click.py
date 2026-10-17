"""Click SHOP API (Prepare / Complete) and Merchant API reversal. Protocol facts are from
docs.click.uz (see ARCHITECTURE 8.2); what the docs do not say is marked there as unconfirmed."""

import hashlib
import uuid
from datetime import timedelta
from decimal import Decimal
from urllib.parse import parse_qs, urlsplit

import pytest
from freezegun import freeze_time

from apps.bookings import services as booking_services
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.bookings.state import status_write_allowed
from apps.payments import services
from apps.payments.models import Payment, PaymentStatus, Refund, RefundReason
from apps.payments.providers.base import ResultKind
from apps.payments.providers.click import ClickProvider
from tests.payments.click_helpers import (
    SECRET,
    SERVICE_ID,
    complete_form,
    md5,
    prepare_form,
    request_for,
    sign_time,
)
from tests.payments.factories import make_payment

pytestmark = pytest.mark.django_db


@pytest.fixture
def click():
    return ClickProvider()


def call(click, form, now):
    return click.handle_webhook(request_for(form), now=now)


def prepare(click, booking, now, **kw):
    return call(click, prepare_form(booking, now, **kw), now)


class TestPrepare:
    def test_accepts_a_valid_prepare(self, click, booking, now):
        result = prepare(click, booking, now)
        payment = Payment.objects.get()
        assert result.payload == {
            "click_trans_id": "1001",
            "merchant_trans_id": str(booking.pk),
            "merchant_prepare_id": str(payment.pk),
            "error": 0,
            "error_note": "Success",
        }
        assert result.result_code == 0
        assert result.method == "prepare"
        assert result.external_id == "1001" and result.booking_id == booking.pk
        assert payment.provider == "click" and payment.external_id == "1001"
        assert payment.provider_ref == "555"
        assert payment.status == PaymentStatus.PENDING
        assert payment.amount == Decimal("12000.00")

    @pytest.mark.parametrize("amount", ["12000", "12000.0", "12000.00"])
    def test_amount_formats(self, click, booking, now, amount):
        assert prepare(click, booking, now, amount=amount).payload["error"] == 0

    def test_repeating_the_same_prepare_gives_the_same_answer(self, click, booking, now):
        first = prepare(click, booking, now)
        second = prepare(click, booking, now)
        assert second.payload == first.payload
        assert Payment.objects.count() == 1

    def test_a_new_attempt_replaces_the_old_open_transaction(self, click, booking, now):
        prepare(click, booking, now, click_trans_id="1001")
        prepare(click, booking, now, click_trans_id="1002")
        statuses = dict(Payment.objects.values_list("external_id", "status"))
        assert statuses == {"1001": "CANCELLED", "1002": "PENDING"}

    def test_wrong_signature(self, click, booking, now):
        result = prepare(click, booking, now, sign_string="0" * 32)
        assert result.payload["error"] == -1
        assert result.payload["error_note"] == "SIGN CHECK FAILED!"
        assert not Payment.objects.exists()

    def test_signature_made_with_another_secret(self, click, booking, now):
        form = prepare_form(booking, now)
        form["sign_string"] = hashlib.md5(b"x").hexdigest()  # noqa: S324
        assert call(click, form, now).payload["error"] == -1

    def test_signature_in_upper_case_is_accepted(self, click, booking, now):
        form = prepare_form(booking, now)
        form["sign_string"] = form["sign_string"].upper()
        assert call(click, form, now).payload["error"] == 0

    def test_missing_signature(self, click, booking, now):
        form = prepare_form(booking, now)
        del form["sign_string"]
        assert call(click, form, now).payload["error"] == -8

    @pytest.mark.parametrize(
        "missing",
        ["click_trans_id", "service_id", "merchant_trans_id", "amount", "action", "sign_time"],
    )
    def test_missing_fields(self, click, booking, now, missing):
        form = prepare_form(booking, now)
        del form[missing]
        assert call(click, form, now).payload["error"] == -8

    def test_garbage_body(self, click, now):
        result = click.handle_webhook(request_for({}), now=now)
        assert result.payload["error"] == -8
        assert result.result_code == -8

    def test_non_form_body(self, click, now):
        from apps.payments.providers.base import WebhookRequest

        result = click.handle_webhook(WebhookRequest(body=b"\xff\xfe{", headers={}), now=now)
        assert result.payload["error"] == -8

    def test_another_service_id(self, click, booking, now):
        # signed correctly for the other service, but it is not ours
        form = prepare_form(booking, now, service_id="99")
        form["sign_string"] = md5(
            form["click_trans_id"],
            "99",
            SECRET,
            form["merchant_trans_id"],
            form["amount"],
            form["action"],
            form["sign_time"],
        )
        assert call(click, form, now).payload["error"] == -8

    @pytest.mark.parametrize("amount", ["11999", "12000.01", "0", "0.00"])
    def test_amount_mismatch(self, click, booking, now, amount):
        assert prepare(click, booking, now, amount=amount).payload["error"] == -2
        assert not Payment.objects.exists()

    @pytest.mark.parametrize("amount", ["abc", "1e4", "-12000", "12000.001", "12 000", "NaN"])
    def test_malformed_amount(self, click, booking, now, amount):
        assert prepare(click, booking, now, amount=amount).payload["error"] == -2

    def test_unknown_order(self, click, booking, now):
        result = prepare(click, booking, now, merchant_trans_id=str(uuid.uuid4()))
        assert result.payload["error"] == -5
        assert result.payload["error_note"] == "User does not exist"

    @pytest.mark.parametrize("order", ["12", "not-a-uuid", "' OR 1=1 --", "0" * 100])
    def test_order_that_is_not_a_uuid_looks_like_an_unknown_order(self, click, booking, now, order):
        assert prepare(click, booking, now, merchant_trans_id=order).payload["error"] == -5

    @pytest.mark.parametrize("status", [S.CONFIRMED, S.ACTIVE, S.COMPLETED])
    def test_already_paid(self, click, booking, now, status):
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=status)
        assert prepare(click, booking, now).payload["error"] == -4

    @pytest.mark.parametrize("status", [S.CANCELLED, S.EXPIRED])
    def test_cancelled_or_expired(self, click, booking, now, status):
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=status)
        assert prepare(click, booking, now).payload["error"] == -9

    def test_hold_over(self, click, booking, now):
        late = now + timedelta(minutes=11)
        assert prepare(click, booking, late).payload["error"] == -9

    @pytest.mark.parametrize("action", ["2", "-1", "x", ""])
    def test_unknown_action(self, click, booking, now, action):
        form = prepare_form(booking, now, action=action)
        result = call(click, form, now)
        assert result.payload["error"] in (-3, -8)

    def test_action_not_found_is_minus_3(self, click, booking, now):
        form = prepare_form(booking, now, action="7")
        assert call(click, form, now).payload["error"] == -3

    def test_click_reporting_its_own_failure_creates_nothing(self, click, booking, now):
        result = prepare(click, booking, now, error="-5")
        assert result.payload["error"] == -8
        assert not Payment.objects.exists()

    def test_old_sign_time_is_a_replay(self, click, booking, now):
        form = prepare_form(booking, now - timedelta(hours=30))
        assert call(click, form, now).payload["error"] == -8

    def test_far_future_sign_time(self, click, booking, now):
        form = prepare_form(booking, now + timedelta(hours=3))
        assert call(click, form, now).payload["error"] == -8

    @pytest.mark.parametrize("value", ["yesterday", "2026-13-45 99:99:99", ""])
    def test_unparseable_sign_time(self, click, booking, now, value):
        form = prepare_form(booking, now, sign_time=value)
        assert call(click, form, now).payload["error"] == -8

    def test_replayed_transaction_id_of_another_booking(self, click, booking, make_pending, now):
        other = make_pending()
        prepare(click, booking, now, click_trans_id="1001")
        result = prepare(click, other, now, click_trans_id="1001")
        assert result.payload["error"] == -8
        assert Payment.objects.count() == 1

    def test_hold_is_stretched_for_the_payment_page(self, click, booking, now):
        late = now + timedelta(minutes=9)
        prepare(click, booking, late)
        booking.refresh_from_db()
        assert booking.hold_expires_at == late + timedelta(minutes=5)

    def test_internal_failure_is_a_protocol_error_without_details(
        self, click, booking, now, monkeypatch
    ):
        def boom(**kwargs):
            raise RuntimeError("db password=hunter2")

        monkeypatch.setattr(services, "register_transaction", boom)
        result = prepare(click, booking, now)
        assert result.payload["error"] == -7
        assert "hunter2" not in str(result.payload)
        assert result.http_status == 200


class TestComplete:
    def prepared(self, click, booking, now):
        return uuid.UUID(prepare(click, booking, now).payload["merchant_prepare_id"])

    def test_accepts_a_valid_complete(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        result = call(click, complete_form(booking, now, prepare_id), now)
        booking.refresh_from_db()
        payment = Payment.objects.get()
        assert result.payload == {
            "click_trans_id": "1001",
            "merchant_trans_id": str(booking.pk),
            "merchant_confirm_id": str(prepare_id),
            "error": 0,
            "error_note": "Success",
        }
        assert result.method == "complete"
        assert booking.status == S.CONFIRMED and booking.paid_amount == Decimal("12000.00")
        assert payment.status == PaymentStatus.PAID

    def test_repeat_is_reported_as_already_paid(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        call(click, complete_form(booking, now, prepare_id), now)
        again = call(click, complete_form(booking, now, prepare_id), now)
        assert again.payload["error"] == -4
        assert again.payload["error_note"] == "Already paid"
        assert Booking.objects.get(pk=booking.pk).paid_amount == Decimal("12000.00")
        assert Refund.objects.count() == 0

    def test_wrong_signature(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        form = complete_form(booking, now, prepare_id, sign_string="a" * 32)
        assert call(click, form, now).payload["error"] == -1
        assert Booking.objects.get(pk=booking.pk).status == S.PENDING_PAYMENT

    def test_prepare_signature_does_not_work_for_complete(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        form = complete_form(booking, now, prepare_id)
        form["sign_string"] = md5(
            "1001", SERVICE_ID, SECRET, str(booking.pk), "12000", "1", form["sign_time"]
        )  # forgot merchant_prepare_id
        assert call(click, form, now).payload["error"] == -1

    @pytest.mark.parametrize("prepare_id", [str(uuid.uuid4()), "nope", "1"])
    def test_unknown_prepare_id(self, click, booking, now, prepare_id):
        self.prepared(click, booking, now)
        form = complete_form(booking, now, prepare_id)
        assert call(click, form, now).payload["error"] == -6

    def test_prepare_id_belongs_to_another_click_transaction(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        form = complete_form(booking, now, prepare_id, click_trans_id="2002")
        assert call(click, form, now).payload["error"] == -6

    def test_order_does_not_match_the_prepared_one(self, click, booking, make_pending, now):
        other = make_pending()
        prepare_id = self.prepared(click, booking, now)
        form = complete_form(other, now, prepare_id)
        assert call(click, form, now).payload["error"] == -5

    def test_amount_does_not_match(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        form = complete_form(booking, now, prepare_id, amount="100")
        assert call(click, form, now).payload["error"] == -2
        assert Booking.objects.get(pk=booking.pk).status == S.PENDING_PAYMENT

    def test_click_reports_a_failed_payment(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        form = complete_form(booking, now, prepare_id, error="-5017", error_note="no money")
        result = call(click, form, now)
        payment = Payment.objects.get()
        assert result.payload["error"] == -9
        assert payment.status == PaymentStatus.CANCELLED
        assert payment.raw_state == {"click_error": -5017}
        assert Booking.objects.get(pk=booking.pk).status == S.PENDING_PAYMENT
        again = call(click, form, now)
        assert again.payload["error"] == -9

    def test_complete_of_a_cancelled_transaction(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        Payment.objects.filter(pk=prepare_id).update(status=PaymentStatus.CANCELLED)
        result = call(click, complete_form(booking, now, prepare_id), now)
        assert result.payload["error"] == -9
        assert Booking.objects.get(pk=booking.pk).status == S.PENDING_PAYMENT

    def test_paid_after_the_driver_cancelled_is_accepted_and_refunded(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        result = call(click, complete_form(booking, now, prepare_id), now)
        booking.refresh_from_db()
        refund = Refund.objects.get()
        assert result.payload["error"] == 0  # the protocol forbids refusing money already taken
        assert booking.status == S.CANCELLED and booking.paid_amount == 0
        assert Payment.objects.get().status == PaymentStatus.PAID
        assert refund.amount == Decimal("12000.00")
        assert refund.reason == RefundReason.UNPAID_BOOKING

    def test_paid_after_the_hold_expired_is_accepted_and_refunded(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        later = now + timedelta(hours=1)
        assert booking_services.expire_hold(booking.pk, now=later) is True
        result = call(click, complete_form(booking, later, prepare_id), later)
        assert result.payload["error"] == 0
        assert Refund.objects.get().reason == RefundReason.UNPAID_BOOKING
        assert Booking.objects.get(pk=booking.pk).status == S.EXPIRED

    def test_paid_twice_the_second_payment_is_refunded(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        payme = services.register_transaction(
            booking_id=booking.pk,
            provider="payme",
            external_id="p" * 24,
            amount=Decimal("12000.00"),
            now=now,
        ).payment
        services.complete_payment(provider="payme", external_id=payme.external_id, now=now)
        result = call(click, complete_form(booking, now, prepare_id), now)
        assert result.payload["error"] == 0
        refund = Refund.objects.get()
        assert refund.reason == RefundReason.DUPLICATE and refund.payment.provider == "click"
        assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED

    def test_hold_that_ran_out_before_the_sweep_is_still_accepted(self, click, booking, now):
        prepare_id = self.prepared(click, booking, now)
        late = now + timedelta(minutes=12)
        result = call(click, complete_form(booking, late, prepare_id), late)
        assert result.payload["error"] == 0
        assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED

    def test_internal_failure_is_a_protocol_error_without_details(
        self, click, booking, now, monkeypatch
    ):
        prepare_id = self.prepared(click, booking, now)

        def boom(**kwargs):
            raise RuntimeError("secret internals")

        monkeypatch.setattr(services, "complete_payment", boom)
        result = call(click, complete_form(booking, now, prepare_id), now)
        assert result.payload["error"] == -7
        assert "secret" not in str(result.payload)


def test_make_payment_helper_is_usable_with_click(booking):
    assert make_payment(booking, provider="click", provider_ref="9").provider_ref == "9"


class TestPaymentUrl:
    def test_contains_only_public_data(self, click, booking):
        url = click.build_payment_url(booking)
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        assert f"{parts.scheme}://{parts.netloc}{parts.path}" == "https://my.click.uz/services/pay"
        assert query == {
            "service_id": ["36"],
            "merchant_id": ["46"],
            "amount": ["12000.00"],
            "transaction_param": [str(booking.pk)],
            "return_url": ["https://habi.test/payment-return"],
        }

    def test_secrets_are_not_in_the_url(self, click, booking):
        url = click.build_payment_url(booking)
        assert SECRET not in url
        assert "sign" not in url
        assert "merchant_user_id" not in url

    def test_return_url_is_omitted_when_not_configured(self, click, booking, settings):
        settings.PAYMENTS_RETURN_URL = ""
        assert "return_url" not in click.build_payment_url(booking)

    def test_amount_is_plain_decimal_text(self, click, booking):
        Booking.objects.filter(pk=booking.pk).update(amount=Decimal("1500.5"))
        booking.refresh_from_db()
        assert parse_qs(urlsplit(click.build_payment_url(booking)).query)["amount"] == ["1500.50"]


class TestRefund:
    def paid_payment(self, booking, ref="555"):
        return make_payment(
            booking,
            provider="click",
            external_id="1001",
            status=PaymentStatus.PAID,
            provider_ref=ref,
        )

    @freeze_time("2026-10-17 10:00:00")
    def test_reversal_request_shape_and_auth_header(self, click, booking, transport):
        payment = self.paid_payment(booking)
        result = click.refund(payment, payment.amount)
        assert result.kind == ResultKind.DONE
        call = transport.calls[0]
        assert call["method"] == "DELETE"
        assert call["url"] == "https://api.click.uz/v2/merchant/payment/reversal/36/555"
        timestamp = str(int(__import__("time").time()))
        digest = hashlib.sha1((timestamp + SECRET).encode()).hexdigest()  # noqa: S324
        assert call["headers"]["Auth"] == f"4:{digest}:{timestamp}"
        assert call["headers"]["Accept"] == "application/json"

    def test_partial_amounts_are_left_to_a_person(self, click, booking, transport):
        payment = self.paid_payment(booking)
        result = click.refund(payment, Decimal("6000"))
        assert result.kind == ResultKind.MANUAL and result.error == "partial_refund_unsupported"
        assert transport.calls == []

    def test_payment_without_a_click_payment_id_cannot_be_reversed(self, click, booking, transport):
        payment = self.paid_payment(booking, ref="")
        result = click.refund(payment, payment.amount)
        assert result.kind == ResultKind.FAILED and result.error == "missing_payment_ref"

    def test_a_malicious_payment_ref_cannot_change_the_url(self, click, booking, transport):
        payment = self.paid_payment(booking, ref="1/../../x?y=")
        result = click.refund(payment, payment.amount)
        assert result.kind == ResultKind.FAILED
        assert transport.calls == []

    @pytest.mark.parametrize(
        "status, data, kind, error",
        [
            (200, {"error_code": 0}, ResultKind.DONE, ""),
            (200, {"error_code": -3}, ResultKind.FAILED, "click_error_-3"),
            (200, {"error_note": "x"}, ResultKind.RETRY, "bad_response"),
            (200, None, ResultKind.RETRY, "bad_response"),
            (500, None, ResultKind.RETRY, "http_500"),
            (503, {"error_code": 0}, ResultKind.RETRY, "http_503"),
            (429, None, ResultKind.RETRY, "http_429"),
            (401, None, ResultKind.FAILED, "http_401"),
            (404, None, ResultKind.FAILED, "http_404"),
        ],
    )
    def test_response_classification(self, click, booking, transport, status, data, kind, error):
        payment = self.paid_payment(booking)
        transport.push(status=status, data=data)
        result = click.refund(payment, payment.amount)
        assert (result.kind, result.error) == (kind, error)

    @pytest.mark.parametrize("code", ["timeout", "network"])
    def test_network_errors_are_retried(self, click, booking, transport, code):
        payment = self.paid_payment(booking)
        transport.push(error=code)
        result = click.refund(payment, payment.amount)
        assert (result.kind, result.error) == (ResultKind.RETRY, code)

    def test_sign_time_helper_matches_tashkent_wall_clock(self, now):
        assert sign_time(now) == now.astimezone(
            __import__("zoneinfo").ZoneInfo("Asia/Tashkent")
        ).strftime("%Y-%m-%d %H:%M:%S")
