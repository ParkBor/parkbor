"""Provider adapter interface (ARCHITECTURE 8.1). One adapter per payment provider; the rest of
the app (services, views, tasks) never knows protocol details."""

import uuid
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum


class ResultKind(StrEnum):
    DONE = "DONE"  # the provider returned the money
    MANUAL = "MANUAL"  # no API for it: a person refunds in the provider's cabinet
    RETRY = "RETRY"  # transient failure, try again later
    FAILED = "FAILED"  # permanent failure, needs a human


@dataclass(frozen=True)
class RefundResult:
    kind: ResultKind
    provider_ref: str = ""
    error: str = ""  # a short CODE ("timeout", "http_502", "click_error_-5"): never free text


@dataclass(frozen=True)
class WebhookRequest:
    """What an adapter needs from an incoming callback; built by the view after the size, IP and
    method checks. ``headers`` keys are lower-case. The body is never logged."""

    body: bytes
    headers: Mapping[str, str]
    remote_ip: str | None = None


@dataclass(frozen=True)
class WebhookResult:
    """The protocol response plus the SAFE facts for the audit log (``WebhookEvent``)."""

    payload: dict
    method: str
    result_code: int = 0
    external_id: str = ""
    booking_id: uuid.UUID | None = None
    http_status: int = 200
    # False when the caller did not prove it is the provider (bad Basic auth / signature, or a
    # request too broken to be signed). Such requests are never stored: only logged.
    authenticated: bool = True


class PaymentProvider(ABC):
    code: str

    def is_configured(self) -> bool:
        """False while the merchant / service ids are missing (dev without credentials): there
        is then no point in handing the app a checkout link that cannot work."""
        return True

    @abstractmethod
    def build_payment_url(self, booking) -> str:
        """Checkout link for a PENDING_PAYMENT booking. Public data only: booking id, amount and
        the merchant / service id. Never a key or a signature."""

    @abstractmethod
    def handle_webhook(self, request: WebhookRequest, *, now: datetime) -> WebhookResult:
        """Authenticate, parse and process one provider callback. Never raises for bad input or
        business errors: every outcome is a protocol response."""

    @abstractmethod
    def refund(self, payment, amount: Decimal, *, attempt: int = 1) -> RefundResult:
        """Return ``amount`` of ``payment`` to the payer (or say that it must be done by hand).
        ``attempt`` > 1 means an earlier call may already have reached the provider (delivery is
        at-least-once), so an adapter may check first or treat "already done" as success."""
