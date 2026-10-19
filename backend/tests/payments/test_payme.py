"""Payme Merchant API (JSON-RPC 2.0). Protocol facts: developer.help.paycom.uz, summarised in
ARCHITECTURE 8.2 (with the parts the docs leave open marked as unconfirmed)."""

import base64
import json
import uuid
from datetime import timedelta
from decimal import Decimal
from unittest import mock
from urllib.parse import unquote

import pytest

from apps.bookings import services as booking_services
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.bookings.state import status_write_allowed
from apps.payments import services
from apps.payments.models import Payment, PaymentStatus, Refund
from apps.payments.providers.base import ResultKind, WebhookRequest
from apps.payments.providers.payme import PaymeProvider
from tests.payments.factories import make_payment, payme_id
from tests.payments.payme_helpers import (
    KEY,
    LOGIN,
    account,
    basic,
    ms,
    request_for,
    rpc,
    tiyin,
)

pytestmark = pytest.mark.django_db
TIMEOUT_MS = 43_200_000


@pytest.fixture
def payme():
    return PaymeProvider()


def call(payme, body, now, **kw):
    return payme.handle_webhook(request_for(body, **kw), now=now)


def ok(result):
    assert "error" not in result.payload, result.payload
    return result.payload["result"]


def error_code(result):
    return result.payload["error"]["code"]


def create(payme, booking, now, *, tx=None, amount=None, rpc_id=7, time=None):
    tx = tx or payme_id()
    params = {
        "id": tx,
        "time": ms(now) if time is None else time,
        "amount": tiyin(booking) if amount is None else amount,
        "account": account(booking),
    }
    return call(payme, rpc("CreateTransaction", params, rpc_id), now), tx


def created(payme, booking, now, **kw):
    result, tx = create(payme, booking, now, **kw)
    ok(result)
    return tx


def perform(payme, tx, now):
    return call(payme, rpc("PerformTransaction", {"id": tx}), now)


def cancel(payme, tx, now, reason=5):
    return call(payme, rpc("CancelTransaction", {"id": tx, "reason": reason}), now)


class TestAuthentication:
    def check_params(self, booking):
        return rpc(
            "CheckPerformTransaction", {"amount": tiyin(booking), "account": account(booking)}
        )

    def test_accepts_the_right_credentials(self, payme, booking, now):
        assert ok(call(payme, self.check_params(booking), now)) == {"allow": True}

    @pytest.mark.parametrize(
        "auth",
        [
            "",
            "Basic",
            "Basic !!!not-base64!!!",
            "Bearer abc",
            "basic " + base64.b64encode(f"{LOGIN}:wrong".encode()).decode(),
            "Basic " + base64.b64encode(f"Other:{KEY}".encode()).decode(),
            "Basic " + base64.b64encode(KEY.encode()).decode(),
            "Basic " + base64.b64encode(f"{LOGIN}:{KEY}x".encode()).decode(),
            "Basic " + base64.b64encode(f"{LOGIN}:{KEY[:-1]}".encode()).decode(),
            "Basic " + base64.b64encode(b"\xff\xfe\x00").decode(),
            "Basic " + "A" * 5000,
        ],
    )
    def test_rejects_everything_else_with_minus_32504(self, payme, booking, now, auth):
        result = call(payme, self.check_params(booking), now, auth=auth)
        assert error_code(result) == -32504
        assert result.payload["id"] == 1
        assert result.http_status == 200
        assert not Payment.objects.exists()

    def test_a_payload_that_is_not_json_is_still_answered_with_the_auth_error(self, payme, now):
        result = payme.handle_webhook(request_for(None, auth="Basic x", raw=b"{not json"), now=now)
        assert error_code(result) == -32504
        assert result.payload["id"] is None

    def test_unauthenticated_requests_never_reach_the_services(self, payme, booking, now):
        with mock.patch.object(services, "check_order") as probe:
            call(payme, self.check_params(booking), now, auth="Basic x")
        probe.assert_not_called()

    def test_the_comparison_is_constant_time(self, payme, booking, now):
        with mock.patch(
            "apps.payments.providers.payme.hmac.compare_digest", return_value=False
        ) as compare:
            result = call(payme, self.check_params(booking), now)
        compare.assert_called_once()
        assert error_code(result) == -32504

    def test_unconfigured_key_rejects_even_matching_empty_credentials(
        self, payme, booking, now, settings
    ):
        settings.PAYME_KEY = ""
        result = call(payme, self.check_params(booking), now, auth=basic(LOGIN, ""))
        assert error_code(result) == -32504

    def test_error_message_is_localised(self, payme, booking, now):
        message = call(payme, self.check_params(booking), now, auth="").payload["error"]["message"]
        assert set(message) == {"ru", "uz", "en"}


class TestProtocolErrors:
    @pytest.mark.parametrize(
        "raw", [b"", b"{", b"not json", b"\xff\xfe", b"[" * 20000, b'{"a": NaN}']
    )
    def test_invalid_json(self, payme, now, raw):
        result = payme.handle_webhook(request_for(None, raw=raw), now=now)
        assert error_code(result) == -32700
        assert result.payload["id"] is None
        assert result.http_status == 200

    @pytest.mark.parametrize(
        "body",
        [
            [],
            "text",
            5,
            None,
            {},
            {"method": "CheckTransaction"},
            {"method": "CheckTransaction", "id": 1},
            {"method": "CheckTransaction", "id": 1, "params": []},
            {"method": 5, "id": 1, "params": {}},
            {"method": "CheckTransaction", "id": "x", "params": {"id": "a"}},
            {"method": "CheckTransaction", "id": True, "params": {"id": "a"}},
            {"method": "CheckTransaction", "id": 1.5, "params": {"id": "a"}},
        ],
    )
    def test_malformed_requests(self, payme, now, body):
        result = call(payme, body, now)
        assert error_code(result) == -32600

    def test_unknown_method_names_itself_in_data(self, payme, now):
        result = call(payme, rpc("DropTables", {}), now)
        assert error_code(result) == -32601
        assert result.payload["error"]["data"] == "DropTables"

    def test_id_is_echoed(self, payme, now):
        assert (
            call(payme, rpc("CheckTransaction", {"id": "a" * 24}, rpc_id=2032), now).payload["id"]
            == 2032
        )

    def test_internal_failure_is_32400_without_details(self, payme, booking, now, monkeypatch):
        def boom(*args, **kwargs):
            raise RuntimeError("password=hunter2 select * from payments")

        monkeypatch.setattr(services, "check_order", boom)
        result = call(
            payme,
            rpc("CheckPerformTransaction", {"amount": tiyin(booking), "account": account(booking)}),
            now,
        )
        assert error_code(result) == -32400
        assert "hunter2" not in json.dumps(result.payload)
        assert result.http_status == 200

    def test_busy_database_is_32400_so_payme_retries(self, payme, booking, now, monkeypatch):
        from apps.bookings.errors import LockTimeout

        def busy(**kwargs):
            raise LockTimeout

        monkeypatch.setattr(services, "register_transaction", busy)
        assert error_code(create(payme, booking, now)[0]) == -32400


class TestCheckPerformTransaction:
    def check(self, payme, booking, now, *, amount=None, account_=None):
        params = {
            "amount": tiyin(booking) if amount is None else amount,
            "account": account(booking) if account_ is None else account_,
        }
        return call(payme, rpc("CheckPerformTransaction", params), now)

    def test_allows_a_payable_order(self, payme, booking, now):
        assert ok(self.check(payme, booking, now)) == {"allow": True}

    @pytest.mark.parametrize("amount", [1, 1_199_999, 1_200_001, 10**9])
    def test_wrong_amount_is_31001(self, payme, booking, now, amount):
        assert error_code(self.check(payme, booking, now, amount=amount)) == -31001

    @pytest.mark.parametrize("amount", [0, -100, 1.5, Decimal("1200000.5")])
    def test_impossible_amounts_are_31001(self, payme, booking, now, amount):
        body = rpc("CheckPerformTransaction", {"amount": 1, "account": account(booking)})
        raw = json.dumps(body).replace('"amount": 1,', f'"amount": {amount},').encode()
        result = payme.handle_webhook(request_for(None, raw=raw), now=now)
        assert error_code(result) == -31001

    @pytest.mark.parametrize("amount", ["1200000", True, [1], {"a": 1}])
    def test_amount_of_the_wrong_type_is_a_malformed_request(self, payme, booking, now, amount):
        assert error_code(self.check(payme, booking, now, amount=amount)) == -32600

    def test_whole_number_written_as_a_float_is_accepted(self, payme, booking, now):
        raw = (
            json.dumps(rpc("CheckPerformTransaction", {"amount": 0, "account": account(booking)}))
            .replace('"amount": 0', '"amount": 1200000.0')
            .encode()
        )
        assert ok(payme.handle_webhook(request_for(None, raw=raw), now=now)) == {"allow": True}

    def test_unknown_order_is_31050_with_the_field_name(self, payme, booking, now):
        result = self.check(payme, booking, now, account_={"order_id": str(uuid.uuid4())})
        error = result.payload["error"]
        assert error["code"] == -31050
        assert error["data"] == "order_id"
        assert set(error["message"]) == {"ru", "uz", "en"}

    @pytest.mark.parametrize("order", ["1", "abc", "' OR 1=1 --", "", "0" * 500, None, 5])
    def test_order_that_is_not_a_uuid_is_indistinguishable_from_an_unknown_one(
        self, payme, booking, now, order
    ):
        assert error_code(self.check(payme, booking, now, account_={"order_id": order})) == -31050

    def test_missing_order_field(self, payme, booking, now):
        assert error_code(self.check(payme, booking, now, account_={})) == -31050

    def test_account_must_be_an_object(self, payme, booking, now):
        assert error_code(self.check(payme, booking, now, account_="x")) == -32600

    @pytest.mark.parametrize("status", [S.CANCELLED, S.EXPIRED, S.CONFIRMED, S.COMPLETED])
    def test_order_that_cannot_take_a_payment_is_31051(self, payme, booking, now, status):
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=status)
        result = self.check(payme, booking, now)
        assert error_code(result) == -31051
        assert result.payload["error"]["data"] == "order_id"

    def test_hold_that_ran_out_is_31051(self, payme, booking, now):
        assert error_code(self.check(payme, booking, now + timedelta(minutes=11))) == -31051

    def test_check_creates_nothing(self, payme, booking, now):
        self.check(payme, booking, now)
        assert not Payment.objects.exists()


class TestCreateTransaction:
    def test_creates_the_transaction(self, payme, booking, now):
        result, tx = create(payme, booking, now)
        data = ok(result)
        payment = Payment.objects.get()
        assert data == {
            "create_time": ms(payment.created_at),
            "transaction": str(payment.pk),
            "state": 1,
        }
        assert result.payload["id"] == 7
        assert payment.external_id == tx and payment.provider == "payme"
        assert payment.provider_time == ms(now)
        assert payment.amount == Decimal("12000.00")  # tiyin only at the boundary
        assert payment.status == PaymentStatus.PENDING
        assert (result.method, result.external_id, result.booking_id) == (
            "CreateTransaction",
            tx,
            booking.pk,
        )

    def test_repeat_returns_the_same_answer(self, payme, booking, now):
        first, tx = create(payme, booking, now)
        again, _ = create(payme, booking, now, tx=tx)
        assert again.payload["result"] == first.payload["result"]
        assert Payment.objects.count() == 1

    def test_repeat_after_the_hold_ended_still_answers(self, payme, booking, now):
        """Payme resends CreateTransaction when it lost the answer: the answer must not change
        just because the hold has meanwhile run out."""
        first, tx = create(payme, booking, now)
        again, _ = create(payme, booking, now + timedelta(minutes=30), tx=tx)
        assert again.payload["result"] == first.payload["result"]

    def test_wrong_amount(self, payme, booking, now):
        assert error_code(create(payme, booking, now, amount=100)[0]) == -31001
        assert not Payment.objects.exists()

    def test_repeat_with_another_amount(self, payme, booking, now):
        tx = created(payme, booking, now)
        assert error_code(create(payme, booking, now, tx=tx, amount=100)[0]) == -31001

    def test_unknown_order(self, payme, booking, now):
        params = {
            "id": payme_id(),
            "time": ms(now),
            "amount": 100,
            "account": {"order_id": str(uuid.uuid4())},
        }
        assert error_code(call(payme, rpc("CreateTransaction", params), now)) == -31050

    @pytest.mark.parametrize("status", [S.CANCELLED, S.EXPIRED, S.CONFIRMED])
    def test_order_that_cannot_take_a_payment(self, payme, booking, now, status):
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=status)
        assert error_code(create(payme, booking, now)[0]) == -31051

    def test_second_open_transaction_for_the_order_is_31008(self, payme, booking, now):
        created(payme, booking, now)
        assert error_code(create(payme, booking, now)[0]) == -31008
        assert Payment.objects.count() == 1

    def test_a_new_transaction_is_allowed_after_the_first_was_cancelled(self, payme, booking, now):
        first = created(payme, booking, now)
        ok(cancel(payme, first, now, reason=3))
        created(payme, booking, now)

    @pytest.mark.parametrize("status", [PaymentStatus.CANCELLED, PaymentStatus.PAID])
    def test_repeat_of_a_finished_transaction_is_31008(self, payme, booking, now, status):
        tx = created(payme, booking, now)
        Payment.objects.filter(external_id=tx).update(status=status)
        assert error_code(create(payme, booking, now, tx=tx)[0]) == -31008

    def test_transaction_older_than_12_hours_is_cancelled_by_timeout(self, payme, booking, now):
        tx = created(payme, booking, now)
        late = now + timedelta(milliseconds=TIMEOUT_MS + 1000)
        assert error_code(create(payme, booking, late, tx=tx)[0]) == -31008
        payment = Payment.objects.get()
        assert payment.status == PaymentStatus.CANCELLED
        assert payment.raw_state["reason"] == 4

    def test_same_transaction_id_for_another_order_is_31008(
        self, payme, booking, make_pending, now
    ):
        other = make_pending()
        tx = created(payme, booking, now)
        assert error_code(create(payme, other, now, tx=tx)[0]) == -31008

    @pytest.mark.parametrize(
        "patch",
        [
            {"id": 5},
            {"id": ""},
            {"id": "a" * 65},
            {"id": None},
            {"time": "x"},
            {"time": None},
            {"time": -1},
            {"time": True},
            {"amount": None},
        ],
    )
    def test_malformed_params(self, payme, booking, now, patch):
        params = {
            "id": payme_id(),
            "time": ms(now),
            "amount": tiyin(booking),
            "account": account(booking),
            **patch,
        }
        assert error_code(call(payme, rpc("CreateTransaction", params), now)) == -32600

    def test_missing_params(self, payme, booking, now):
        for missing in ("id", "time", "amount", "account"):
            params = {
                "id": payme_id(),
                "time": ms(now),
                "amount": tiyin(booking),
                "account": account(booking),
            }
            del params[missing]
            assert error_code(call(payme, rpc("CreateTransaction", params), now)) == -32600

    def test_hold_is_stretched_for_the_open_payment_page(self, payme, booking, now):
        late = now + timedelta(minutes=9)
        created(payme, booking, late)
        booking.refresh_from_db()
        assert booking.hold_expires_at == late + timedelta(minutes=5)


class TestPerformTransaction:
    def test_confirms_the_booking(self, payme, booking, now):
        tx = created(payme, booking, now)
        result = perform(payme, tx, now)
        payment = Payment.objects.get()
        booking.refresh_from_db()
        assert ok(result) == {
            "transaction": str(payment.pk),
            "perform_time": ms(now),
            "state": 2,
        }
        assert payment.status == PaymentStatus.PAID
        assert booking.status == S.CONFIRMED
        assert booking.paid_amount == Decimal("12000.00")

    def test_repeat_returns_the_same_answer(self, payme, booking, now):
        tx = created(payme, booking, now)
        first = perform(payme, tx, now)
        again = perform(payme, tx, now + timedelta(minutes=3))
        assert again.payload["result"] == first.payload["result"]
        assert Booking.objects.get(pk=booking.pk).paid_amount == Decimal("12000.00")

    def test_unknown_transaction(self, payme, now):
        assert error_code(perform(payme, payme_id(), now)) == -31003

    def test_cancelled_transaction_cannot_be_performed(self, payme, booking, now):
        tx = created(payme, booking, now)
        cancel(payme, tx, now)
        assert error_code(perform(payme, tx, now)) == -31008

    def test_refunded_transaction_cannot_be_performed(self, payme, booking, now):
        tx = created(payme, booking, now)
        perform(payme, tx, now)
        cancel(payme, tx, now)
        assert error_code(perform(payme, tx, now)) == -31008

    def test_expired_booking_is_31008_and_nothing_changes(self, payme, booking, now):
        tx = created(payme, booking, now)
        later = now + timedelta(hours=1)
        booking_services.expire_hold(booking.pk, now=later)
        assert error_code(perform(payme, tx, later)) == -31008
        assert Booking.objects.get(pk=booking.pk).status == S.EXPIRED
        assert Payment.objects.get().status == PaymentStatus.PENDING
        assert not Refund.objects.exists()

    def test_booking_cancelled_by_the_driver_is_31008(self, payme, booking, now):
        tx = created(payme, booking, now)
        booking_services.cancel_booking(booking_id=booking.pk, user=booking.user, now=now)
        assert error_code(perform(payme, tx, now)) == -31008

    def test_hold_that_ran_out_before_the_sweep_is_still_accepted(self, payme, booking, now):
        tx = created(payme, booking, now)
        late = now + timedelta(minutes=12)
        assert ok(perform(payme, tx, late))["state"] == 2
        assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED

    def test_transaction_older_than_12_hours_is_cancelled_by_timeout(self, payme, booking, now):
        tx = created(payme, booking, now)
        late = now + timedelta(milliseconds=TIMEOUT_MS + 1000)
        assert error_code(perform(payme, tx, late)) == -31008
        payment = Payment.objects.get()
        assert payment.status == PaymentStatus.CANCELLED and payment.raw_state["reason"] == 4
        assert Booking.objects.get(pk=booking.pk).status == S.PENDING_PAYMENT

    def test_the_other_provider_paid_first(self, payme, booking, now):
        tx = created(payme, booking, now)
        click = services.register_transaction(
            booking_id=booking.pk,
            provider="click",
            external_id="5",
            amount=Decimal("12000.00"),
            now=now,
        ).payment
        services.complete_payment(provider="click", external_id=click.external_id, now=now)
        assert error_code(perform(payme, tx, now)) == -31008
        assert not Refund.objects.exists()  # refused, so there is nothing to give back

    @pytest.mark.parametrize("params", [{}, {"id": 5}, {"id": ""}, {"id": "x" * 65}])
    def test_malformed_params(self, payme, now, params):
        assert error_code(call(payme, rpc("PerformTransaction", params), now)) == -32600


class TestCancelTransaction:
    def test_cancels_an_open_transaction(self, payme, booking, now):
        tx = created(payme, booking, now)
        cancel_time = now + timedelta(minutes=1)
        result = cancel(payme, tx, cancel_time, reason=3)
        payment = Payment.objects.get()
        assert ok(result) == {
            "transaction": str(payment.pk),
            "cancel_time": ms(cancel_time),
            "state": -1,
        }
        assert payment.status == PaymentStatus.CANCELLED
        assert payment.raw_state["reason"] == 3
        assert Booking.objects.get(pk=booking.pk).status == S.PENDING_PAYMENT

    def test_repeat_returns_the_same_answer(self, payme, booking, now):
        tx = created(payme, booking, now)
        first = cancel(payme, tx, now, reason=3)
        again = cancel(payme, tx, now + timedelta(minutes=5), reason=4)
        assert again.payload["result"] == first.payload["result"]
        assert Payment.objects.get().raw_state["reason"] == 3

    def test_cancels_a_performed_transaction(self, payme, booking, now):
        tx = created(payme, booking, now)
        perform(payme, tx, now)
        result = cancel(payme, tx, now, reason=5)
        booking.refresh_from_db()
        assert ok(result)["state"] == -2
        assert Payment.objects.get().status == PaymentStatus.REFUNDED
        assert booking.status == S.CANCELLED and booking.refund_amount == Decimal("12000.00")

    @pytest.mark.parametrize("status", [S.ACTIVE, S.OVERSTAY, S.COMPLETED])
    def test_cannot_cancel_once_the_service_was_provided(self, payme, booking, now, status):
        tx = created(payme, booking, now)
        perform(payme, tx, now)
        with status_write_allowed():
            Booking.objects.filter(pk=booking.pk).update(status=status)
        assert error_code(cancel(payme, tx, now)) == -31007
        assert Payment.objects.get().status == PaymentStatus.PAID

    def test_unknown_transaction(self, payme, now):
        assert error_code(cancel(payme, payme_id(), now)) == -31003

    @pytest.mark.parametrize("reason", [None, "5", 1.5, True, [5]])
    def test_reason_must_be_an_integer(self, payme, booking, now, reason):
        tx = created(payme, booking, now)
        result = call(payme, rpc("CancelTransaction", {"id": tx, "reason": reason}), now)
        assert error_code(result) == -32600

    def test_reason_is_required(self, payme, booking, now):
        tx = created(payme, booking, now)
        assert error_code(call(payme, rpc("CancelTransaction", {"id": tx}), now)) == -32600

    def test_cancel_after_the_booking_expired_still_works(self, payme, booking, now):
        tx = created(payme, booking, now)
        later = now + timedelta(hours=1)
        booking_services.expire_hold(booking.pk, now=later)
        assert ok(cancel(payme, tx, later, reason=4))["state"] == -1


class TestCheckTransaction:
    def check(self, payme, tx, now):
        return call(payme, rpc("CheckTransaction", {"id": tx}), now)

    def test_pending(self, payme, booking, now):
        tx = created(payme, booking, now)
        payment = Payment.objects.get()
        assert ok(self.check(payme, tx, now)) == {
            "create_time": ms(payment.created_at),
            "perform_time": 0,
            "cancel_time": 0,
            "transaction": str(payment.pk),
            "state": 1,
            "reason": None,
        }

    def test_performed(self, payme, booking, now):
        tx = created(payme, booking, now)
        perform(payme, tx, now)
        data = ok(self.check(payme, tx, now))
        assert data["state"] == 2 and data["perform_time"] == ms(now) and data["cancel_time"] == 0

    def test_cancelled_before_and_after_performing(self, payme, booking, make_pending, now):
        first = created(payme, booking, now)
        cancel(payme, first, now, reason=3)
        data = ok(self.check(payme, first, now))
        assert (data["state"], data["reason"], data["cancel_time"]) == (-1, 3, ms(now))
        other = make_pending()
        second = created(payme, other, now)
        perform(payme, second, now)
        cancel(payme, second, now, reason=5)
        data = ok(self.check(payme, second, now))
        assert (data["state"], data["reason"], data["perform_time"]) == (-2, 5, ms(now))

    def test_unknown(self, payme, now):
        assert error_code(self.check(payme, payme_id(), now)) == -31003


class TestGetStatement:
    def statement(self, payme, now, start, end):
        return call(payme, rpc("GetStatement", {"from": start, "to": end}), now)

    def test_empty_period(self, payme, now):
        assert ok(self.statement(payme, now, 0, 10)) == {"transactions": []}

    def test_lists_transactions_by_payme_creation_time_oldest_first(
        self, payme, booking, make_pending, now
    ):
        other = make_pending()
        t1, t2 = ms(now), ms(now) + 5000
        late = created(payme, other, now, time=t2)
        early = created(payme, booking, now, time=t1)
        perform(payme, early, now)
        data = ok(self.statement(payme, now, t1, t2))["transactions"]
        assert [row["id"] for row in data] == [early, late]
        first = data[0]
        payment = Payment.objects.get(external_id=early)
        assert first == {
            "id": early,
            "time": t1,
            "amount": 1_200_000,
            "account": {"order_id": str(booking.pk)},
            "create_time": ms(payment.created_at),
            "perform_time": ms(now),
            "cancel_time": 0,
            "transaction": str(payment.pk),
            "state": 2,
            "reason": None,
        }

    def test_bounds_are_inclusive(self, payme, booking, now):
        tx = created(payme, booking, now, time=1000)
        rows = ok(self.statement(payme, now, 1000, 1000))["transactions"]
        assert [r["id"] for r in rows] == [tx]
        assert ok(self.statement(payme, now, 1001, 2000)) == {"transactions": []}
        assert ok(self.statement(payme, now, 0, 999)) == {"transactions": []}

    def test_transactions_of_other_providers_are_not_listed(self, payme, booking, now):
        make_payment(booking, provider="click", external_id="3", provider_time=5)
        assert ok(self.statement(payme, now, 0, 100)) == {"transactions": []}

    @pytest.mark.parametrize(
        "params", [{}, {"from": 1}, {"from": "a", "to": 2}, {"from": 1, "to": None}]
    )
    def test_malformed(self, payme, now, params):
        assert error_code(call(payme, rpc("GetStatement", params), now)) == -32600

    def test_reversed_period_is_empty(self, payme, booking, now):
        created(payme, booking, now, time=1000)
        assert ok(self.statement(payme, now, 2000, 1000)) == {"transactions": []}

    def test_result_size_is_capped(self, payme, booking, make_pending, now, settings):
        settings.PAYMENTS_STATEMENT_LIMIT = 1
        created(payme, booking, now, time=1000)
        created(payme, make_pending(), now, time=2000)
        assert len(ok(self.statement(payme, now, 0, 5000))["transactions"]) == 1


class TestPaymentUrl:
    def decode(self, url):
        base, _, tail = url.rpartition("/")
        return base, base64.b64decode(unquote(tail)).decode()

    def test_checkout_url_carries_only_public_data(self, payme, booking):
        base, params = self.decode(payme.build_payment_url(booking))
        assert base == "https://test.paycom.uz"  # the test settings run in sandbox mode
        assert params == (
            f"m=587f72c72cac0d162c722ae2;ac.order_id={booking.pk};a=1200000;l=uz;"
            "c=https://parkbor.test/payment-return"
        )

    def test_production_checkout_url(self, payme, booking, settings):
        settings.PAYMENTS_SANDBOX = False
        assert payme.build_payment_url(booking).startswith("https://checkout.paycom.uz/")

    def test_the_key_is_not_in_the_url(self, payme, booking):
        url = payme.build_payment_url(booking)
        assert KEY not in url
        assert KEY not in self.decode(url)[1]
        assert base64.b64encode(KEY.encode()).decode() not in url

    def test_amount_is_in_tiyin(self, payme, booking):
        Booking.objects.filter(pk=booking.pk).update(amount=Decimal("1500.5"))
        booking.refresh_from_db()
        assert ";a=150050;" in self.decode(payme.build_payment_url(booking))[1]

    def test_return_url_is_optional(self, payme, booking, settings):
        settings.PAYMENTS_RETURN_URL = ""
        assert ";c=" not in self.decode(payme.build_payment_url(booking))[1]

    def test_slashes_of_the_base64_text_cannot_split_the_path(self, payme, booking, settings):
        """Standard base64 can contain '/', which would end the URL path segment."""
        encoded = []
        for question_marks in range(3, 12):  # runs of '?' make base64 emit '/' at some alignment
            settings.PAYMENTS_RETURN_URL = "https://parkbor.test/?" + "?" * question_marks
            url = payme.build_payment_url(booking)
            assert url.count("/") == 3  # "https://host/" and nothing else
            payload = url.rpartition("/")[2]
            encoded.append(payload)
            assert (
                base64.b64decode(unquote(payload)).decode().endswith(settings.PAYMENTS_RETURN_URL)
            )
        assert any("%2F" in payload for payload in encoded)  # the case really occurred


class TestRefund:
    def test_payme_refunds_are_made_in_the_cabinet(self, payme, booking):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        result = payme.refund(payment, payment.amount)
        assert result.kind == ResultKind.MANUAL and result.error == "payme_cabinet_refund"


def test_get_request_object_shape():
    request = WebhookRequest(body=b"{}", headers={})
    assert request.remote_ip is None


def test_method_name_and_external_id_are_audited(payme, booking, now):
    result = call(payme, rpc("CheckTransaction", {"id": payme_id()}), now)
    assert result.method == "CheckTransaction"
    assert result.result_code == -31003
    assert result.external_id


class TestTimeoutIsVisibleEverywhere:
    LATE = timedelta(milliseconds=TIMEOUT_MS + 1000)

    def test_check_transaction_reports_the_timeout_cancel(self, payme, booking, now):
        tx = created(payme, booking, now)
        result = call(payme, rpc("CheckTransaction", {"id": tx}), now + self.LATE)
        data = ok(result)
        assert (data["state"], data["reason"]) == (-1, 4)
        assert data["cancel_time"] == ms(now + self.LATE)
        assert Payment.objects.get().status == PaymentStatus.CANCELLED

    def test_statement_reports_the_timeout_cancel(self, payme, booking, now):
        created(payme, booking, now, time=1000)
        late = now + self.LATE
        row = ok(call(payme, rpc("GetStatement", {"from": 0, "to": 5000}), late))["transactions"][0]
        assert (row["state"], row["reason"]) == (-1, 4)

    def test_a_young_transaction_is_untouched_by_reads(self, payme, booking, now):
        tx = created(payme, booking, now)
        call(payme, rpc("CheckTransaction", {"id": tx}), now + timedelta(hours=1))
        assert Payment.objects.get().status == PaymentStatus.PENDING


class TestCancelRepeatAfterRefund:
    def test_repeated_cancel_of_a_refunded_transaction_is_idempotent(self, payme, booking, now):
        tx = created(payme, booking, now)
        perform(payme, tx, now)
        first = cancel(payme, tx, now, reason=5)
        again = cancel(payme, tx, now + timedelta(minutes=3), reason=5)
        assert ok(first)["state"] == -2
        assert again.payload["result"] == first.payload["result"]
        assert Refund.objects.count() == 1


class TestReasonRange:
    @pytest.mark.parametrize("reason", [0, 6, 9, 11, -1, 100])
    def test_unknown_reasons_are_malformed(self, payme, booking, now, reason):
        tx = created(payme, booking, now)
        assert error_code(cancel(payme, tx, now, reason=reason)) == -32600

    @pytest.mark.parametrize("reason", [1, 2, 3, 4, 5, 10])
    def test_documented_reasons_are_accepted(self, payme, booking, now, reason):
        tx = created(payme, booking, now)
        assert ok(cancel(payme, tx, now, reason=reason))["state"] == -1


class TestHostileNumbers:
    """Python's Decimal raises ArithmeticError for absurd exponents: never a 500."""

    BODIES = [
        '{"method": "CheckTransaction", "id": 1, "params": {"id": "a", "n": 1e9999999999}}',
        '{"method": "CheckTransaction", "id": 1, "params": {"id": "a", "n": 1e-9999999999}}',
        '{"method": "CheckTransaction", "id": 1, "params": {"id": "a", "n": 0e9999999999}}',
        '{"method": "CheckTransaction", "id": 1, "params": {"id": "a", "n": 1E+999999999}}',
        '{"method": "CreateTransaction", "id": 1, "params": {"amount": 1e999999999999}}',
        # beyond Decimal's exponent range json.loads itself raises decimal.InvalidOperation
        '{"method": "CheckTransaction", "id": 1, "params": {"id": "a", "n": 1e999999999999999999999}}',
        '{"method": "CheckTransaction", "id": 1, "params": {"id": "a", "n": 1e-999999999999999999999}}',
    ]

    @pytest.mark.parametrize("body", BODIES)
    def test_authenticated(self, payme, now, body):
        result = payme.handle_webhook(request_for(None, raw=body.encode()), now=now)
        assert error_code(result) in (-32700, -32600, -31003)
        assert result.http_status == 200

    @pytest.mark.parametrize("body", BODIES)
    def test_unauthenticated(self, payme, now, body):
        request = request_for(None, raw=body.encode(), auth="Basic x")
        result = payme.handle_webhook(request, now=now)
        assert error_code(result) == -32504 and result.authenticated is False

    def test_through_http(self, body=BODIES[0]):
        from django.test import Client

        response = Client().post(
            "/api/v1/payments/payme/webhook",
            data=body,
            content_type="text/json",
            REMOTE_ADDR="1.2.3.4",
        )
        assert response.status_code == 200
