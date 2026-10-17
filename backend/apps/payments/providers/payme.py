"""Payme adapter: Merchant API (JSON-RPC 2.0, Payme calls us) and the checkout link.

Protocol (developer.help.paycom.uz, verified 2026-10; ARCHITECTURE 8.4 lists what is NOT
confirmed):

* POST, ``Authorization: Basic base64("Paycom:<KEY>")``, JSON-RPC 2.0, HTTP status always 200
  (anything else is read by Payme as -32400). Amounts in TIYIN (1 so'm = 100 tiyin).
* Account field ``order_id`` = our booking id (a one-time account).
* Methods: CheckPerformTransaction, CreateTransaction, PerformTransaction, CancelTransaction,
  CheckTransaction, GetStatement. Transaction states 1 (created), 2 (performed), -1 (cancelled
  before perform), -2 (cancelled after perform). A transaction not performed within 12 hours is
  cancelled with reason 4.
* Errors: -32504 auth, -32700 / -32600 / -32601 / -32300 / -32400 general, -31001 amount, -31003
  no such transaction, -31007 cannot cancel (service provided), -31008 cannot perform in this
  state, -31050..-31099 account errors (``data`` = the account sub-field).

The adapter only translates; every state change is a ``services`` call (lot-first locking).
"""

import base64
import binascii
import hmac
import json
import logging
import uuid
from datetime import datetime
from decimal import Decimal
from urllib.parse import quote

from apps.core.exceptions import ApiError

from .. import conf, errors, money, selectors, services
from ..models import Payment, PaymentStatus
from .base import PaymentProvider, RefundResult, ResultKind, WebhookRequest, WebhookResult

logger = logging.getLogger(__name__)

TIMEOUT_MS = 43_200_000  # 12 hours: Payme cancels an unperformed transaction by timeout
TIMEOUT_REASON = 4
REASONS = frozenset({1, 2, 3, 4, 5, 10})  # the documented cancellation reasons
MAX_AUTH_HEADER_LENGTH = 512
MAX_TRANSACTION_ID_LENGTH = 64
ORDER_FIELD = "order_id"

NOT_POST, AUTH_FAILED, PARSE_ERROR = -32300, -32504, -32700
INVALID_REQUEST, NO_METHOD, SYSTEM_ERROR = -32600, -32601, -32400
WRONG_AMOUNT, NO_TRANSACTION, CANNOT_CANCEL, CANNOT_PERFORM = -31001, -31003, -31007, -31008
NO_ORDER, ORDER_NOT_PAYABLE = -31050, -31051

MESSAGES = {
    NOT_POST: ("Метод запроса не POST", "So'rov usuli POST emas", "The request method is not POST"),
    AUTH_FAILED: (
        "Недостаточно привилегий для выполнения метода",
        "Usulni bajarish uchun huquq yetarli emas",
        "Insufficient privileges to perform this method",
    ),
    PARSE_ERROR: ("Ошибка разбора JSON", "JSON xatosi", "JSON parse error"),
    INVALID_REQUEST: ("Неверный запрос", "Noto'g'ri so'rov", "Invalid request"),
    NO_METHOD: ("Метод не найден", "Metod topilmadi", "Method not found"),
    SYSTEM_ERROR: ("Системная ошибка", "Tizim xatosi", "System error"),
    WRONG_AMOUNT: ("Неверная сумма", "Noto'g'ri summa", "Incorrect amount"),
    NO_TRANSACTION: ("Транзакция не найдена", "Tranzaksiya topilmadi", "Transaction not found"),
    CANNOT_CANCEL: (
        "Невозможно отменить транзакцию: услуга оказана",
        "Tranzaksiyani bekor qilib bo'lmaydi: xizmat ko'rsatilgan",
        "The transaction cannot be cancelled: the service has been provided",
    ),
    CANNOT_PERFORM: (
        "Невозможно выполнить операцию",
        "Operatsiyani bajarib bo'lmaydi",
        "Unable to perform the operation",
    ),
    NO_ORDER: ("Заказ не найден", "Buyurtma topilmadi", "Order not found"),
    ORDER_NOT_PAYABLE: (
        "Заказ не может быть оплачен",
        "Buyurtmani to'lab bo'lmaydi",
        "The order cannot be paid",
    ),
}
STATES = {
    PaymentStatus.CREATED: 1,
    PaymentStatus.PENDING: 1,
    PaymentStatus.PAID: 2,
    PaymentStatus.CANCELLED: -1,
    PaymentStatus.FAILED: -1,
    PaymentStatus.REFUNDED: -2,
}


class _Rpc(Exception):  # noqa: N818 - control flow: "answer this protocol error"
    def __init__(self, code: int, data: str | None = None):
        super().__init__(code)
        self.code = code
        self.data = data


def _reject_constant(name: str):
    raise ValueError(name)  # NaN / Infinity are not JSON


def _ms(moment: datetime | None) -> int:
    return 0 if moment is None else int(moment.timestamp() * 1000)


def _state(payment: Payment) -> int:
    return STATES[payment.status]


def _reason(payment: Payment):
    reason = payment.raw_state.get("reason")
    return reason if isinstance(reason, int) else None


class PaymeProvider(PaymentProvider):
    code = "payme"

    # --- checkout link ----------------------------------------------------------------------

    def is_configured(self) -> bool:
        return bool(conf.payme_config().merchant_id)

    def build_payment_url(self, booking) -> str:
        """``<checkout>/base64(m=<merchant>;ac.order_id=<booking>;a=<tiyin>;l=<lang>[;c=<back>])``
        (GET form of the receipt). Public data only. The base64 text is percent-encoded so a '/'
        inside it cannot end the path segment (unconfirmed how Payme decodes; see 8.4)."""
        cfg = conf.payme_config()
        general = conf.get_config()
        parts = [
            f"m={cfg.merchant_id}",
            f"ac.{ORDER_FIELD}={booking.pk}",
            f"a={money.to_tiyin(booking.amount)}",
            f"l={general.lang}",
        ]
        if general.return_url:
            parts.append(f"c={general.return_url}")
        encoded = base64.b64encode(";".join(parts).encode()).decode()
        return f"{cfg.checkout_url}/{quote(encoded, safe='+=')}"

    # --- Merchant API -----------------------------------------------------------------------

    def handle_webhook(self, request: WebhookRequest, *, now: datetime) -> WebhookResult:
        body, load_error = self._load(request.body)
        rpc_id = self._rpc_id(body)
        method = "unknown"
        params: dict = {}
        authenticated = False
        try:
            self._authenticate(request.headers.get("authorization", ""))
            authenticated = True
            if load_error:
                raise _Rpc(PARSE_ERROR)
            method, params = self._envelope(body)
            handler = self.METHODS.get(method)
            if handler is None:
                raise _Rpc(NO_METHOD, method)
            payload = {"result": handler(self, params, now), "id": rpc_id}
            code = 0
        except _Rpc as rpc_error:
            payload, code = self._error(rpc_error, rpc_id), rpc_error.code
        except Exception as exc:  # noqa: BLE001 - never leak internals; Payme retries
            level = logging.WARNING if isinstance(exc, ApiError) else logging.ERROR
            logger.log(level, "payme %s failed: %s", method, type(exc).__name__)
            payload, code = self._error(_Rpc(SYSTEM_ERROR), rpc_id), SYSTEM_ERROR
        external_id, booking_id = self._audit_fields(params)
        return WebhookResult(
            payload=payload,
            method=method,
            result_code=code,
            external_id=external_id,
            booking_id=booking_id,
            authenticated=authenticated,
        )

    def method_not_allowed(self) -> WebhookResult:
        """Protocol: a request whose HTTP method is not POST gets -32300 (HTTP 200)."""
        return WebhookResult(
            payload=self._error(_Rpc(NOT_POST), None),
            method="unknown",
            result_code=NOT_POST,
            authenticated=False,
        )

    # --- envelope -------------------------------------------------------------------------

    @staticmethod
    def _load(raw: bytes):
        try:
            text = raw.decode("utf-8")
            return json.loads(text, parse_float=Decimal, parse_constant=_reject_constant), False
        except (
            UnicodeDecodeError,
            ValueError,
            RecursionError,
            ArithmeticError,
        ):  # Decimal overflow
            return None, True

    @staticmethod
    def _rpc_id(body) -> int | None:
        value = body.get("id") if isinstance(body, dict) else None
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    @staticmethod
    def _authenticate(header: str) -> None:
        """Basic auth against ``Paycom:<KEY>``; one constant-time comparison of the whole
        credential. An unconfigured key rejects everything."""
        key = conf.payme_config().key
        provided = PaymeProvider._basic_credentials(header)
        expected = f"{conf.payme_config().login}:{key}".encode()
        # compare_digest runs even for a missing/garbled header, so timing does not tell them apart
        matches = hmac.compare_digest(provided or b"\x00", expected)
        if not key or provided is None or not matches:
            raise _Rpc(AUTH_FAILED)

    @staticmethod
    def _basic_credentials(header: str) -> bytes | None:
        if not header or len(header) > MAX_AUTH_HEADER_LENGTH:
            return None
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "basic" or not token:
            return None
        try:
            return base64.b64decode(token.strip(), validate=True)
        except (binascii.Error, ValueError):
            return None

    @staticmethod
    def _envelope(body) -> tuple[str, dict]:
        if not isinstance(body, dict):
            raise _Rpc(INVALID_REQUEST)
        method, params, rpc_id = body.get("method"), body.get("params"), body.get("id")
        if not isinstance(method, str) or not isinstance(params, dict):
            raise _Rpc(INVALID_REQUEST)
        if isinstance(rpc_id, bool) or not isinstance(rpc_id, int):
            raise _Rpc(INVALID_REQUEST)
        return method, params

    @staticmethod
    def _error(error: _Rpc, rpc_id) -> dict:
        ru, uz, en = MESSAGES[error.code]
        body = {"code": error.code, "message": {"ru": ru, "uz": uz, "en": en}}
        if error.data is not None:
            body["data"] = error.data
        return {"error": body, "id": rpc_id}

    @staticmethod
    def _audit_fields(params: dict) -> tuple[str, uuid.UUID | None]:
        tx = params.get("id")
        account = params.get("account")
        order = account.get(ORDER_FIELD) if isinstance(account, dict) else None
        booking_id = None
        if isinstance(order, str):
            try:
                booking_id = uuid.UUID(order)
            except ValueError:
                booking_id = None
        return (tx[:64] if isinstance(tx, str) else ""), booking_id

    # --- parameters -----------------------------------------------------------------------

    @staticmethod
    def _tx_id(params: dict) -> str:
        value = params.get("id")
        if not isinstance(value, str) or not 0 < len(value) <= MAX_TRANSACTION_ID_LENGTH:
            raise _Rpc(INVALID_REQUEST)
        return value

    @staticmethod
    def _timestamp(params: dict, name: str) -> int:
        value = params.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise _Rpc(INVALID_REQUEST)
        return value

    @staticmethod
    def _amount(params: dict) -> Decimal:
        """So'm as Decimal. A wrong TYPE is a malformed request; a number that is not a positive
        whole amount of tiyin is "incorrect amount" (it can never match an order)."""
        value = params.get("amount")
        if not money.is_number(value):
            raise _Rpc(INVALID_REQUEST)
        try:
            return money.from_tiyin(money.parse_tiyin(value))
        except money.InvalidAmount:
            return Decimal(-1)

    @staticmethod
    def _order(params: dict) -> uuid.UUID | None:
        """The booking id from ``account.order_id``; None when absent or not a UUID, which is
        answered exactly like an unknown order (no way to probe for valid ids)."""
        account = params.get("account")
        if not isinstance(account, dict):
            raise _Rpc(INVALID_REQUEST)
        value = account.get(ORDER_FIELD)
        if not isinstance(value, str):
            return None
        try:
            return uuid.UUID(value)
        except ValueError:
            return None

    @staticmethod
    def _map(error: errors.PaymentError, *, performing: bool = False) -> _Rpc:
        if isinstance(error, errors.OrderNotFound):
            return _Rpc(NO_ORDER, ORDER_FIELD)
        if isinstance(error, errors.OrderNotPayable | errors.OrderAlreadyPaid):
            return _Rpc(CANNOT_PERFORM) if performing else _Rpc(ORDER_NOT_PAYABLE, ORDER_FIELD)
        if isinstance(error, errors.AmountMismatch):
            return _Rpc(WRONG_AMOUNT)
        if isinstance(error, errors.TransactionNotFound):
            return _Rpc(NO_TRANSACTION)
        if isinstance(error, errors.OrderCompleted):
            return _Rpc(CANNOT_CANCEL)
        return _Rpc(CANNOT_PERFORM)

    # --- methods --------------------------------------------------------------------------

    def _check_perform(self, params: dict, now: datetime) -> dict:
        amount = self._amount(params)
        order = self._order(params)
        if order is None:
            raise _Rpc(NO_ORDER, ORDER_FIELD)
        try:
            services.check_order(order, amount, now=now)
        except errors.PaymentError as exc:
            raise self._map(exc) from None
        return {"allow": True}

    def _create(self, params: dict, now: datetime) -> dict:
        tx = self._tx_id(params)
        provider_time = self._timestamp(params, "time")
        amount = self._amount(params)
        order = self._order(params)
        existing = selectors.get_payment("payme", tx)
        if existing is not None:
            return self._create_again(existing, order, amount, now)
        if order is None:
            raise _Rpc(NO_ORDER, ORDER_FIELD)
        try:
            registered = services.register_transaction(
                booking_id=order,
                provider="payme",
                external_id=tx,
                amount=amount,
                now=now,
                provider_time=provider_time,
            )
        except errors.PaymentError as exc:
            raise self._map(exc) from None
        return self._created_result(registered.payment)

    def _create_again(self, payment: Payment, order, amount: Decimal, now: datetime) -> dict:
        """Payme repeats CreateTransaction when it lost our answer: same answer, no new rows."""
        if payment.booking_id != order or payment.status != PaymentStatus.PENDING:
            raise _Rpc(CANNOT_PERFORM)
        if self._timed_out(payment, now):
            self._cancel_by_timeout(payment, now)
            raise _Rpc(CANNOT_PERFORM)
        if payment.amount != amount:
            raise _Rpc(WRONG_AMOUNT)
        return self._created_result(payment)

    @staticmethod
    def _created_result(payment: Payment) -> dict:
        return {
            "create_time": _ms(payment.created_at),
            "transaction": str(payment.pk),
            "state": _state(payment),
        }

    def _perform(self, params: dict, now: datetime) -> dict:
        tx = self._tx_id(params)
        payment = selectors.get_payment("payme", tx)
        if payment is None:
            raise _Rpc(NO_TRANSACTION)
        if payment.status == PaymentStatus.PENDING and self._timed_out(payment, now):
            self._cancel_by_timeout(payment, now)
            raise _Rpc(CANNOT_PERFORM)
        try:
            payment = services.complete_payment(provider="payme", external_id=tx, now=now).payment
        except errors.PaymentError as exc:
            raise self._map(exc, performing=True) from None
        return {
            "transaction": str(payment.pk),
            "perform_time": _ms(payment.performed_at),
            "state": _state(payment),
        }

    def _cancel(self, params: dict, now: datetime) -> dict:
        tx = self._tx_id(params)
        reason = params.get("reason")
        if isinstance(reason, bool) or not isinstance(reason, int) or reason not in REASONS:
            raise _Rpc(INVALID_REQUEST)
        try:
            payment = services.cancel_transaction(
                provider="payme", external_id=tx, now=now, raw={"reason": reason}
            ).payment
        except errors.PaymentError as exc:
            raise self._map(exc) from None
        return {
            "transaction": str(payment.pk),
            "cancel_time": _ms(payment.cancelled_at),
            "state": _state(payment),
        }

    def _check_transaction(self, params: dict, now: datetime) -> dict:
        payment = selectors.get_payment("payme", self._tx_id(params))
        if payment is None:
            raise _Rpc(NO_TRANSACTION)
        payment = self._apply_timeout(payment, now)
        return {
            "create_time": _ms(payment.created_at),
            "perform_time": _ms(payment.performed_at),
            "cancel_time": _ms(payment.cancelled_at),
            "transaction": str(payment.pk),
            "state": _state(payment),
            "reason": _reason(payment),
        }

    def _statement(self, params: dict, now: datetime) -> dict:
        start, end = self._timestamp(params, "from"), self._timestamp(params, "to")
        rows = selectors.payme_statement(start, end, conf.get_config().statement_limit)
        rows = [self._apply_timeout(payment, now) for payment in rows]
        return {"transactions": [self._statement_row(payment) for payment in rows]}

    @staticmethod
    def _statement_row(payment: Payment) -> dict:
        return {
            "id": payment.external_id,
            "time": payment.provider_time,
            "amount": money.to_tiyin(payment.amount),
            "account": {ORDER_FIELD: str(payment.booking_id)},
            "create_time": _ms(payment.created_at),
            "perform_time": _ms(payment.performed_at),
            "cancel_time": _ms(payment.cancelled_at),
            "transaction": str(payment.pk),
            "state": _state(payment),
            "reason": _reason(payment),
        }

    METHODS = {  # noqa: RUF012
        "CheckPerformTransaction": _check_perform,
        "CreateTransaction": _create,
        "PerformTransaction": _perform,
        "CancelTransaction": _cancel,
        "CheckTransaction": _check_transaction,
        "GetStatement": _statement,
    }

    # --- timeout ----------------------------------------------------------------------------

    @staticmethod
    def _timed_out(payment: Payment, now: datetime) -> bool:
        started = payment.provider_time or _ms(payment.created_at)
        return _ms(now) - started > TIMEOUT_MS

    def _apply_timeout(self, payment: Payment, now: datetime) -> Payment:
        """Reads must tell the truth Payme will see: a transaction past 12 hours is cancelled
        (reason 4) even if nobody asked about it before."""
        if payment.status == PaymentStatus.PENDING and self._timed_out(payment, now):
            self._cancel_by_timeout(payment, now)
            return selectors.get_payment("payme", payment.external_id) or payment
        return payment

    @staticmethod
    def _cancel_by_timeout(payment: Payment, now: datetime) -> None:
        services.cancel_transaction(
            provider="payme",
            external_id=payment.external_id,
            now=now,
            raw={"reason": TIMEOUT_REASON},
        )

    # --- refunds ----------------------------------------------------------------------------

    def refund(self, payment, amount: Decimal, *, attempt: int = 1) -> RefundResult:
        """The Merchant API has no call for the merchant to start a refund: the merchant refunds
        in the Payme Business cabinet, and Payme then calls CancelTransaction (reason 5), which
        settles the refund automatically (services.cancel_transaction). Until then: MANUAL."""
        return RefundResult(ResultKind.MANUAL, error="payme_cabinet_refund")
