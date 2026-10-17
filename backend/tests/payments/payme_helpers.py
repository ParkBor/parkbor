"""Builders for Payme Merchant API (JSON-RPC 2.0) requests."""

import base64
import json

from apps.payments.providers.base import WebhookRequest

LOGIN = "Paycom"
KEY = "test-payme-key-0123456789-abcdefghij"


def basic(login=LOGIN, key=KEY) -> str:
    return "Basic " + base64.b64encode(f"{login}:{key}".encode()).decode()


def rpc(method, params=None, rpc_id=1) -> dict:
    body = {"method": method, "id": rpc_id}
    if params is not None:
        body["params"] = params
    return body


def request_for(body, *, auth=None, ip="185.234.113.5", raw: bytes | None = None) -> WebhookRequest:
    payload = raw if raw is not None else json.dumps(body).encode()
    headers = {"content-type": "text/json; charset=UTF-8"}
    headers["authorization"] = basic() if auth is None else auth
    if auth == "":
        del headers["authorization"]
    return WebhookRequest(body=payload, headers=headers, remote_ip=ip)


def account(booking) -> dict:
    return {"order_id": str(booking.pk)}


def tiyin(booking) -> int:
    return int(booking.amount * 100)


def ms(moment) -> int:
    return int(moment.timestamp() * 1000)
