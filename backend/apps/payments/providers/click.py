"""Click adapter: SHOP API (Prepare / Complete callbacks) and Merchant API (payment reversal).

Protocol (docs.click.uz, verified 2026-10; see ARCHITECTURE 8.4 for what is NOT confirmed):

* Click POSTs ``application/x-www-form-urlencoded`` to our URL; we answer JSON, HTTP 200.
* ``sign_string = md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
  [+ merchant_prepare_id for Complete] + amount + action + sign_time)``.
* action 0 = Prepare, 1 = Complete. Errors 0 / -1 .. -9 (see ``NOTES``).
* After a successful Prepare and a debit, Complete cannot be an error except -4 (already paid)
  and -9 (cancelled). A booking that died in between therefore gets the money accepted and is
  refunded automatically (Merchant API reversal), instead of being refused.
"""

import hashlib
import hmac
import logging
import time
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from urllib.parse import parse_qsl, urlencode
from zoneinfo import ZoneInfo

from apps.core.exceptions import ApiError

from .. import conf, errors, money, selectors, services
from ..models import PaymentStatus
from .base import (
    PaymentProvider,
    RefundResult,
    ResultKind,
    WebhookRequest,
    WebhookResult,
)
from .http import TransportError, get_transport

logger = logging.getLogger(__name__)

TASHKENT = ZoneInfo("Asia/Tashkent")
MAX_FIELDS = 40
MAX_VALUE_LENGTH = 128
FUTURE_TOLERANCE = timedelta(hours=1)
SIGN_TIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M")
PROVIDER_REF_DIGITS = 20

SUCCESS, SIGN_FAILED, BAD_AMOUNT, NO_ACTION, ALREADY_PAID = 0, -1, -2, -3, -4
NO_USER, NO_TRANSACTION, UPDATE_FAILED, BAD_REQUEST, CANCELLED = -5, -6, -7, -8, -9
NOTES = {
    SUCCESS: "Success",
    SIGN_FAILED: "SIGN CHECK FAILED!",
    BAD_AMOUNT: "Incorrect parameter amount",
    NO_ACTION: "Action not found",
    ALREADY_PAID: "Already paid",
    NO_USER: "User does not exist",
    NO_TRANSACTION: "Transaction does not exist",
    UPDATE_FAILED: "Failed to update user",
    BAD_REQUEST: "Error in request from click",
    CANCELLED: "Transaction cancelled",
}
COMMON = ("click_trans_id", "service_id", "merchant_trans_id", "amount", "action", "sign_time")


class _Reject(Exception):  # noqa: N818 - control flow: "answer this protocol error"
    def __init__(self, code: int, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def _parse_form(body: bytes) -> dict[str, str] | None:
    """The first value of every key; None for anything that is not a sane small form. A key sent
    twice is refused: it would let two parties read different values of a signed field."""
    try:
        pairs = parse_qsl(
            body.decode("utf-8"),
            keep_blank_values=True,
            max_num_fields=MAX_FIELDS,
            strict_parsing=False,
        )
    except (UnicodeDecodeError, ValueError):
        return None
    form: dict[str, str] = {}
    for key, value in pairs:
        if key in form or len(value) > MAX_VALUE_LENGTH or len(key) > MAX_VALUE_LENGTH:
            return None
        form[key] = value
    return form


def _uuid_or_none(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _md5(*parts: str) -> str:
    # MD5 is what the Click protocol prescribes for sign_string; it is not our choice.
    return hashlib.md5("".join(parts).encode(), usedforsecurity=False).hexdigest()


def _signature_ok(form: dict[str, str], secret: str, *, complete: bool) -> bool:
    parts = [form["click_trans_id"], form["service_id"], secret, form["merchant_trans_id"]]
    if complete:
        parts.append(form["merchant_prepare_id"])
    parts += [form["amount"], form["action"], form["sign_time"]]
    expected = _md5(*parts).encode()
    return hmac.compare_digest(expected, form["sign_string"].strip().lower().encode())


def _parse_sign_time(value: str) -> datetime | None:
    for fmt in SIGN_TIME_FORMATS:
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=TASHKENT)  # noqa: DTZ007
        except ValueError:
            continue
    return None


class ClickProvider(PaymentProvider):
    code = "click"

    # --- checkout link --------------------------------------------------------------------

    def is_configured(self) -> bool:
        cfg = conf.click_config()
        return bool(cfg.service_id and cfg.merchant_id)

    def build_payment_url(self, booking) -> str:
        cfg = conf.click_config()
        query = {
            "service_id": cfg.service_id,
            "merchant_id": cfg.merchant_id,
            "amount": money.format_soum(booking.amount),
            "transaction_param": str(booking.pk),
        }
        return_url = conf.get_config().return_url
        if return_url:
            query["return_url"] = return_url
        return f"{cfg.pay_url}?{urlencode(query)}"

    # --- callbacks ------------------------------------------------------------------------

    def handle_webhook(self, request: WebhookRequest, *, now: datetime) -> WebhookResult:
        form = _parse_form(request.body)
        method = "unknown"
        authed = False
        try:
            if form is None:
                raise _Reject(BAD_REQUEST)
            self._require(form, COMMON)
            action = self._action(form)
            method = "prepare" if action == 0 else "complete"
            self._authenticate(form, complete=action == 1)
            authed = True  # the signature checked out: from here on the input is Click's
            self._check_service(form)
            payload, external_id, booking_id = (
                self._prepare(form, now) if action == 0 else self._complete(form, now)
            )
        except _Reject as rejection:
            return self._answer(form, method, rejection.code, rejection.extra, authed)
        except Exception as exc:  # noqa: BLE001 - never leak internals; Click retries
            level = logging.WARNING if isinstance(exc, ApiError) else logging.ERROR
            logger.log(level, "click %s failed: %s", method, type(exc).__name__)
            return self._answer(form, method, UPDATE_FAILED, {}, authed)
        return WebhookResult(
            payload=payload,
            method=method,
            result_code=SUCCESS,
            external_id=external_id,
            booking_id=booking_id,
        )

    @staticmethod
    def _require(form: dict[str, str], names) -> None:
        if any(not form.get(name, "").strip() for name in names):
            raise _Reject(BAD_REQUEST)

    @staticmethod
    def _action(form: dict[str, str]) -> int:
        try:
            action = int(form["action"])
        except ValueError:
            raise _Reject(BAD_REQUEST) from None
        if action not in (0, 1):
            raise _Reject(NO_ACTION)
        return action

    def _authenticate(self, form: dict[str, str], *, complete: bool) -> None:
        self._require(form, ("sign_string", *(("merchant_prepare_id",) if complete else ())))
        cfg = conf.click_config()
        if not cfg.secret_key:  # unconfigured: refuse everything rather than sign with ""
            raise _Reject(SIGN_FAILED)
        if not _signature_ok(form, cfg.secret_key, complete=complete):
            raise _Reject(SIGN_FAILED)

    @staticmethod
    def _check_service(form: dict[str, str]) -> None:
        if form["service_id"] != conf.click_config().service_id:
            raise _Reject(BAD_REQUEST)

    def _answer(self, form, method: str, code: int, extra: dict, authed: bool) -> WebhookResult:
        """The protocol answer. Ids are echoed (and audited) ONLY for requests whose signature
        checked out: nothing an anonymous caller sends is ever reflected or stored."""
        payload = {"error": code, "error_note": NOTES[code], **extra}
        external_id = ""
        booking_id = None
        if authed and form is not None:
            payload = {
                "click_trans_id": form["click_trans_id"],
                "merchant_trans_id": form.get("merchant_trans_id", ""),
                **payload,
            }
            external_id = form["click_trans_id"][:64]
            booking_id = _uuid_or_none(form.get("merchant_trans_id", ""))
        return WebhookResult(
            payload=payload,
            method=method,
            result_code=code,
            external_id=external_id,
            booking_id=booking_id,
            authenticated=authed,
        )

    # --- Prepare ----------------------------------------------------------------------------

    def _prepare(self, form: dict[str, str], now: datetime):
        if form.get("error", "0").strip() not in ("0", ""):
            raise _Reject(BAD_REQUEST)  # Click itself reports a failure: nothing to reserve
        self._check_sign_time(form["sign_time"], now)
        amount = self._amount(form["amount"])
        order_id = _uuid_or_none(form["merchant_trans_id"])
        if order_id is None:
            raise _Reject(NO_USER)
        try:
            registered = services.register_transaction(
                booking_id=order_id,
                provider="click",
                external_id=form["click_trans_id"],
                amount=amount,
                now=now,
                provider_ref=form.get("click_paydoc_id", "")[:64],
                supersede=True,
            )
        except errors.PaymentError as exc:
            raise _Reject(self._map_order_error(exc)) from None
        payment = registered.payment
        if payment.status == PaymentStatus.PAID:
            raise _Reject(ALREADY_PAID)
        if payment.status != PaymentStatus.PENDING:
            raise _Reject(CANCELLED)
        payload = {
            "click_trans_id": form["click_trans_id"],
            "merchant_trans_id": form["merchant_trans_id"],
            "merchant_prepare_id": str(payment.pk),
            "error": SUCCESS,
            "error_note": NOTES[SUCCESS],
        }
        return payload, payment.external_id, payment.booking_id

    @staticmethod
    def _check_sign_time(value: str, now: datetime) -> None:
        """Replay guard for Prepare: the signed time must be recent. (Complete is matched to its
        Prepare by id and cannot be replayed into a second payment.) Click's clock zone is not
        documented: Asia/Tashkent is assumed; the window is wide enough for UTC too."""
        moment = _parse_sign_time(value)
        if moment is None:
            raise _Reject(BAD_REQUEST)
        if moment < now - conf.get_config().click_sign_max_age or moment > now + FUTURE_TOLERANCE:
            raise _Reject(BAD_REQUEST)

    @staticmethod
    def _amount(text: str) -> Decimal:
        try:
            return money.parse_soum_text(text)
        except money.InvalidAmount:
            raise _Reject(BAD_AMOUNT) from None

    @staticmethod
    def _map_order_error(exc: errors.PaymentError) -> int:
        if isinstance(exc, errors.OrderNotFound):
            return NO_USER
        if isinstance(exc, errors.OrderAlreadyPaid):
            return ALREADY_PAID
        if isinstance(exc, errors.OrderNotPayable | errors.TransactionStateError):
            return CANCELLED
        if isinstance(exc, errors.AmountMismatch):
            return BAD_AMOUNT
        if isinstance(exc, errors.TransactionNotFound):
            return NO_TRANSACTION
        return BAD_REQUEST

    # --- Complete -----------------------------------------------------------------------------

    def _complete(self, form: dict[str, str], now: datetime):
        payment = self._find_prepared(form)
        order_id = _uuid_or_none(form["merchant_trans_id"])
        if order_id != payment.booking_id:
            raise _Reject(NO_USER)
        if self._amount(form["amount"]) != payment.amount:
            raise _Reject(BAD_AMOUNT)
        confirm = {"merchant_confirm_id": str(payment.pk)}
        if payment.status == PaymentStatus.PAID:
            raise _Reject(ALREADY_PAID, **confirm)
        if payment.status != PaymentStatus.PENDING:
            raise _Reject(CANCELLED)
        failure = form.get("error", "0").strip() or "0"
        if failure != "0":
            self._cancel(payment, failure, now)
            raise _Reject(CANCELLED)
        try:
            services.complete_payment(
                provider="click",
                external_id=payment.external_id,
                now=now,
                accept_unpayable=True,
                provider_ref=form.get("click_paydoc_id", "")[:64],
            )
        except errors.PaymentError as exc:
            raise _Reject(self._map_order_error(exc)) from None
        payload = {
            "click_trans_id": form["click_trans_id"],
            "merchant_trans_id": form["merchant_trans_id"],
            "merchant_confirm_id": str(payment.pk),
            "error": SUCCESS,
            "error_note": NOTES[SUCCESS],
        }
        return payload, payment.external_id, payment.booking_id

    @staticmethod
    def _find_prepared(form: dict[str, str]):
        prepare_id = _uuid_or_none(form["merchant_prepare_id"])
        if prepare_id is None:
            raise _Reject(NO_TRANSACTION)
        payment = selectors.get_click_payment_by_id(prepare_id)
        if payment is None or payment.external_id != form["click_trans_id"]:
            raise _Reject(NO_TRANSACTION)
        return payment

    @staticmethod
    def _cancel(payment, failure: str, now: datetime) -> None:
        try:
            code = int(failure)
        except ValueError:
            code = BAD_REQUEST
        services.cancel_transaction(
            provider="click",
            external_id=payment.external_id,
            now=now,
            raw={"click_error": code},
        )

    # --- refunds (Merchant API) ---------------------------------------------------------------

    def refund(self, payment, amount: Decimal, *, attempt: int = 1) -> RefundResult:
        """Reverse a payment through the Merchant API. Only a full reversal is documented, so a
        partial refund is left to a person (``MANUAL``) instead of guessing an endpoint."""
        if amount != payment.amount:
            return RefundResult(ResultKind.MANUAL, error="partial_refund_unsupported")
        ref = payment.provider_ref
        if not ref:
            return RefundResult(ResultKind.FAILED, error="missing_payment_ref")
        if not (ref.isascii() and ref.isdigit() and len(ref) <= PROVIDER_REF_DIGITS):
            return RefundResult(ResultKind.FAILED, error="invalid_payment_ref")
        cfg = conf.click_config()
        if attempt > 1 and self._already_reversed(cfg, ref):
            return RefundResult(ResultKind.DONE, provider_ref=ref)
        url = f"{cfg.api_url}/payment/reversal/{cfg.service_id}/{ref}"
        try:
            response = get_transport().request(
                "DELETE",
                url,
                headers=self._api_headers(cfg),
                timeout=conf.get_config().http_timeout_seconds,
            )
        except TransportError as exc:
            return RefundResult(ResultKind.RETRY, error=str(exc))
        return self._classify(response, ref)

    def _already_reversed(self, cfg, ref: str) -> bool:
        """Before RE-sending a reversal (an earlier call may have succeeded with its answer lost),
        ask Click for the payment status. UNCONFIRMED: the response shape is not in the docs, so
        this runs only with ``CLICK_STATUS_CHECK`` on and compares ``payment_status`` to the
        operator-supplied ``CLICK_STATUS_REVERSED_VALUES``. Any problem -> False (just re-send)."""
        general = conf.get_config()
        if not general.click_status_check or not general.click_status_reversed_values:
            return False
        url = f"{cfg.api_url}/payment/status/{cfg.service_id}/{ref}"
        try:
            response = get_transport().request(
                "GET", url, headers=self._api_headers(cfg), timeout=general.http_timeout_seconds
            )
        except TransportError:
            return False
        status = (response.data or {}).get("payment_status")
        return (
            response.status == 200
            and isinstance(status, int)
            and not isinstance(status, bool)
            and status in general.click_status_reversed_values
        )

    @staticmethod
    def _api_headers(cfg) -> dict[str, str]:
        timestamp = str(int(time.time()))
        # SHA-1 of timestamp + secret is the Merchant API's prescribed Auth digest.
        digest = hashlib.sha1((timestamp + cfg.secret_key).encode(), usedforsecurity=False)
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Auth": f"{cfg.merchant_user_id}:{digest.hexdigest()}:{timestamp}",
        }

    @staticmethod
    def _classify(response, ref: str) -> RefundResult:
        if response.status >= 500 or response.status == 429:
            return RefundResult(ResultKind.RETRY, error=f"http_{response.status}")
        if response.status != 200:
            return RefundResult(ResultKind.FAILED, error=f"http_{response.status}")
        code = (response.data or {}).get("error_code")
        if isinstance(code, bool) or not isinstance(code, int):
            return RefundResult(ResultKind.RETRY, error="bad_response")
        if code in conf.get_config().click_reversal_done_codes:
            # UNCONFIRMED code list (operator-supplied): "already reversed" = the earlier call won.
            return RefundResult(ResultKind.DONE, provider_ref=ref)
        if code != 0:
            return RefundResult(ResultKind.FAILED, error=f"click_error_{code}")
        return RefundResult(ResultKind.DONE, provider_ref=ref)
