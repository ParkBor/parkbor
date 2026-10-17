"""Payment settings, read at call time (``override_settings`` works in tests).

Secrets live in dataclass fields with ``repr=False`` so they cannot leak through a log line or a
traceback that prints the object.
"""

from dataclasses import dataclass, field
from datetime import timedelta
from ipaddress import IPv4Network, IPv6Network

from django.conf import settings

from .settings_checks import parse_networks


@dataclass(frozen=True)
class PaymentsConfig:
    default_provider: str
    sandbox: bool
    return_url: str
    lang: str
    hold_grace: timedelta
    max_body_bytes: int
    refund_max_attempts: int
    refund_backoff_seconds: int
    http_timeout_seconds: int
    stale: timedelta
    batch_limit: int
    click_sign_max_age: timedelta
    statement_limit: int
    lock_timeout_seconds: int
    alert_after: timedelta
    event_retention: timedelta
    click_reversal_done_codes: frozenset[int]
    click_status_check: bool
    click_status_reversed_values: frozenset[int]


@dataclass(frozen=True)
class PaymeConfig:
    merchant_id: str
    login: str
    checkout_url: str
    key: str = field(repr=False)


@dataclass(frozen=True)
class ClickConfig:
    service_id: str
    merchant_id: str
    merchant_user_id: str
    pay_url: str
    api_url: str
    secret_key: str = field(repr=False)


def get_config() -> PaymentsConfig:
    s = settings
    return PaymentsConfig(
        default_provider=s.PAYMENTS_DEFAULT_PROVIDER,
        sandbox=bool(s.PAYMENTS_SANDBOX),
        return_url=s.PAYMENTS_RETURN_URL,
        lang=s.PAYMENTS_DEFAULT_LANG,
        hold_grace=timedelta(minutes=s.PAYMENTS_HOLD_GRACE_MINUTES),
        max_body_bytes=s.PAYMENTS_WEBHOOK_MAX_BODY_BYTES,
        refund_max_attempts=s.PAYMENTS_REFUND_MAX_ATTEMPTS,
        refund_backoff_seconds=s.PAYMENTS_REFUND_BACKOFF_SECONDS,
        http_timeout_seconds=s.PAYMENTS_REFUND_HTTP_TIMEOUT_SECONDS,
        stale=timedelta(minutes=s.PAYMENTS_STALE_MINUTES),
        batch_limit=s.PAYMENTS_TASK_BATCH_LIMIT,
        click_sign_max_age=timedelta(hours=s.PAYMENTS_CLICK_SIGN_MAX_AGE_HOURS),
        statement_limit=s.PAYMENTS_STATEMENT_LIMIT,
        lock_timeout_seconds=s.PAYMENTS_LOCK_TIMEOUT_SECONDS,
        alert_after=timedelta(hours=s.PAYMENTS_ALERT_HOURS),
        event_retention=timedelta(days=s.PAYMENTS_EVENT_RETENTION_DAYS),
        click_reversal_done_codes=frozenset(s.CLICK_REVERSAL_DONE_CODES),
        click_status_check=bool(s.CLICK_STATUS_CHECK),
        click_status_reversed_values=frozenset(s.CLICK_STATUS_REVERSED_VALUES),
    )


def payme_config() -> PaymeConfig:
    s = settings
    url = s.PAYME_SANDBOX_CHECKOUT_URL if s.PAYMENTS_SANDBOX else s.PAYME_CHECKOUT_URL
    return PaymeConfig(
        merchant_id=s.PAYME_MERCHANT_ID, login=s.PAYME_LOGIN, checkout_url=url, key=s.PAYME_KEY
    )


def click_config() -> ClickConfig:
    s = settings
    return ClickConfig(
        service_id=s.CLICK_SERVICE_ID,
        merchant_id=s.CLICK_MERCHANT_ID,
        merchant_user_id=s.CLICK_MERCHANT_USER_ID,
        pay_url=s.CLICK_PAY_URL,
        api_url=s.CLICK_API_URL,
        secret_key=s.CLICK_SECRET_KEY,
    )


def ip_allowlist(provider: str) -> list[IPv4Network | IPv6Network]:
    """Networks allowed to call ``provider``'s webhook; empty = the check is off."""
    specific = {"payme": settings.PAYMENTS_PAYME_IPS, "click": settings.PAYMENTS_CLICK_IPS}
    values = specific.get(provider) or settings.PAYMENTS_PROVIDER_IPS
    return parse_networks(list(values), "PAYMENTS_*_IPS")
