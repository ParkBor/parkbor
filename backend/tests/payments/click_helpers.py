"""Builders for Click SHOP API requests (form-urlencoded, md5-signed)."""

import hashlib
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from apps.payments.providers.base import WebhookRequest

SERVICE_ID = "36"
SECRET = "test-click-secret"
TASHKENT = ZoneInfo("Asia/Tashkent")
FORM = {"content-type": "application/x-www-form-urlencoded"}


def sign_time(now) -> str:
    return now.astimezone(TASHKENT).strftime("%Y-%m-%d %H:%M:%S")


def md5(*parts) -> str:
    return hashlib.md5("".join(str(p) for p in parts).encode()).hexdigest()  # noqa: S324


def prepare_form(booking, now, *, click_trans_id="1001", amount=None, **over) -> dict:
    form = {
        "click_trans_id": click_trans_id,
        "service_id": SERVICE_ID,
        "click_paydoc_id": "555",
        "merchant_trans_id": str(booking.pk),
        "amount": amount if amount is not None else "12000",
        "action": "0",
        "error": "0",
        "error_note": "Success",
        "sign_time": sign_time(now),
    }
    form.update(over)
    if "sign_string" not in over:
        form["sign_string"] = md5(
            form["click_trans_id"],
            form["service_id"],
            SECRET,
            form["merchant_trans_id"],
            form["amount"],
            form["action"],
            form["sign_time"],
        )
    return form


def complete_form(booking, now, prepare_id, *, click_trans_id="1001", amount=None, **over) -> dict:
    form = {
        "click_trans_id": click_trans_id,
        "service_id": SERVICE_ID,
        "click_paydoc_id": "555",
        "merchant_trans_id": str(booking.pk),
        "merchant_prepare_id": str(prepare_id),
        "amount": amount if amount is not None else "12000",
        "action": "1",
        "error": "0",
        "error_note": "Success",
        "sign_time": sign_time(now),
    }
    form.update(over)
    if "sign_string" not in over:
        form["sign_string"] = md5(
            form["click_trans_id"],
            form["service_id"],
            SECRET,
            form["merchant_trans_id"],
            form["merchant_prepare_id"],
            form["amount"],
            form["action"],
            form["sign_time"],
        )
    return form


def request_for(form: dict, ip="203.0.113.7") -> WebhookRequest:
    return WebhookRequest(body=urlencode(form).encode(), headers=FORM, remote_ip=ip)
