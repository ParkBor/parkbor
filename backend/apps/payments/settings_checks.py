"""Startup validation of the payment settings. Pure (no app imports): ``config.settings.prod``
calls it while settings are still being built. Messages name the setting, never its value."""

import ipaddress
import re
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

MIN_PAYME_KEY_LENGTH = 32  # Payme issues 36-character keys
MIN_CLICK_SECRET_LENGTH = 12
PLACEHOLDER_PREFIXES = ("replace-me", "replace_me", "changeme", "change-me", "todo", "xxx")
# Payme publishes these addresses (developer.help.paycom.uz, "Схема взаимодействия").
PAYME_PUBLISHED_IPS = [f"185.234.113.{n}" for n in range(1, 16)]
PAYME_CHECKOUT_HOSTS = frozenset({"checkout.paycom.uz"})
UNSAFE_SCHEMES = frozenset({"http", "ftp", "file", "data", "javascript", "blob"})
_DEEP_LINK = re.compile(r"^[a-z][a-z0-9+.-]*://[^\s;]+$")


def parse_networks(
    values: list[str], setting_name: str
) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """Parse an allowlist of addresses / CIDR blocks; a typo must stop startup, not silently
    open (or close) the webhook."""
    networks = []
    for raw in values:
        try:
            networks.append(ipaddress.ip_network(raw.strip(), strict=False))
        except ValueError as exc:
            raise ImproperlyConfigured(
                f"{setting_name} has an invalid address or network."
            ) from exc
    return networks


def _require(name: str, value: str, min_length: int = 1) -> None:
    stripped = value.strip()
    if not stripped or stripped.lower().startswith(PLACEHOLDER_PREFIXES):
        raise ImproperlyConfigured(f"{name} is required in production.")
    if len(stripped) < min_length:
        raise ImproperlyConfigured(f"{name} must be at least {min_length} characters.")


def _check_return_url(url: str) -> None:
    """Empty, https, or an app deep link (``parkbor://...``). Never plain http; never ';' (Payme's
    GET checkout format splits parameters on it)."""
    if not url:
        return
    if ";" in url:
        raise ImproperlyConfigured("PAYMENTS_RETURN_URL must not contain ';'.")
    scheme = url.partition(":")[0].lower()
    if scheme in UNSAFE_SCHEMES or not (
        url.lower().startswith("https://") or _DEEP_LINK.match(url)
    ):
        raise ImproperlyConfigured("PAYMENTS_RETURN_URL must be https or an app deep link.")


def _check_checkout_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in PAYME_CHECKOUT_HOSTS:
        raise ImproperlyConfigured("PAYME_CHECKOUT_URL must be the real https checkout.")


def validate_production(conf: dict) -> None:
    """``conf`` maps setting names to values. Raises ImproperlyConfigured on the first problem."""
    _require("PAYME_MERCHANT_ID", conf["PAYME_MERCHANT_ID"])
    _require("PAYME_KEY", conf["PAYME_KEY"], MIN_PAYME_KEY_LENGTH)
    _require("CLICK_SERVICE_ID", conf["CLICK_SERVICE_ID"])
    _require("CLICK_MERCHANT_ID", conf["CLICK_MERCHANT_ID"])
    _require("CLICK_MERCHANT_USER_ID", conf["CLICK_MERCHANT_USER_ID"])
    _require("CLICK_SECRET_KEY", conf["CLICK_SECRET_KEY"], MIN_CLICK_SECRET_LENGTH)
    if conf["PAYMENTS_SANDBOX"]:
        raise ImproperlyConfigured("PAYMENTS_SANDBOX must be off in production.")
    shared = parse_networks(conf["PAYMENTS_PROVIDER_IPS"], "PAYMENTS_PROVIDER_IPS")
    payme = parse_networks(conf["PAYMENTS_PAYME_IPS"], "PAYMENTS_PAYME_IPS")
    parse_networks(conf["PAYMENTS_CLICK_IPS"], "PAYMENTS_CLICK_IPS")
    if not (payme or shared):  # Click's addresses are unconfirmed (optional); Payme's are published
        raise ImproperlyConfigured("The Payme IP allowlist must not be empty in production.")
    _check_return_url(conf["PAYMENTS_RETURN_URL"])
    _check_checkout_url(conf["PAYME_CHECKOUT_URL"])
