"""Edge checks shared by the webhook endpoints: who may call, how much they may send."""

import ipaddress
import logging
import time

from rest_framework.permissions import BasePermission
from rest_framework.throttling import BaseThrottle, SimpleRateThrottle

from apps.core.exceptions import ApiError, DomainPermissionDenied

from . import conf

logger = logging.getLogger(__name__)


class PayloadTooLarge(ApiError):
    status_code = 413
    default_detail = "The request body is too large."
    default_code = "payload_too_large"


def client_ip(request) -> str | None:
    """The caller's address as DRF sees it: ``REMOTE_ADDR``, or the right-most trusted hop of
    ``X-Forwarded-For`` according to ``NUM_PROXIES`` (0 = the header is ignored, so it cannot be
    spoofed). Returns None when it is not a valid address."""
    ident = BaseThrottle().get_ident(request)
    try:
        return str(_normalise(ipaddress.ip_address((ident or "").strip())))
    except ValueError:
        return None


def _normalise(ip):
    """``::ffff:1.2.3.4`` (a dual-stack socket) is the IPv4 address 1.2.3.4."""
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped if mapped is not None else ip


def ip_allowed(provider: str, address: str | None) -> bool:
    """True if the provider's allowlist is empty (check off) or contains ``address``."""
    networks = conf.ip_allowlist(provider)
    if not networks:
        return True
    if address is None:
        return False
    ip = _normalise(ipaddress.ip_address(address))
    return any(ip.version == network.version and ip in network for network in networks)


class ProviderIpAllowed(BasePermission):
    """Second layer after the signature / Basic auth: only the provider's own addresses."""

    def has_permission(self, request, view) -> bool:
        if not ip_allowed(view.provider_code, client_ip(request)):
            raise DomainPermissionDenied("Forbidden.")
        return True


def read_body(request) -> bytes:
    """The raw body, never more than ``PAYMENTS_WEBHOOK_MAX_BODY_BYTES``. The declared length is
    checked BEFORE anything is read, so an oversized request costs no memory."""
    limit = conf.get_config().max_body_bytes
    try:
        declared = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        raise PayloadTooLarge from None
    if declared > limit:
        raise PayloadTooLarge
    body = request._request.body  # noqa: SLF001 - DRF would parse JSON only; we need raw bytes
    if len(body) > limit:
        raise PayloadTooLarge
    return body


class WebhookIpThrottle(SimpleRateThrottle):
    """Per client IP (``payment_webhook``, 600/min): wide, since a provider retries from a few
    addresses; it stops floods, the signature check is the actual gate."""

    scope = "payment_webhook"

    # Resolve time.time at call time (a plain builtin attribute gets rewritten by time freezing).
    timer = staticmethod(lambda: time.time())

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
