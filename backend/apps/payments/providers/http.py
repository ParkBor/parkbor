"""The only way the payments app talks to a provider's API (Click refunds). A tiny seam, so
tests install a fake and nothing in the test suite can reach the network.

Nothing here logs or raises with a URL, header or body: Click's Auth header carries a digest of
the secret key and httpx would otherwise happily put URLs into messages.
"""

from dataclasses import dataclass
from typing import Protocol

import httpx


class TransportError(Exception):
    """Network-level failure. The message is a short code ("timeout", "network"), never a URL."""


@dataclass(frozen=True)
class HttpResult:
    status: int
    data: dict | None  # parsed JSON object, or None when the body was not one


class Transport(Protocol):
    def request(
        self, method: str, url: str, *, headers: dict[str, str], timeout: float
    ) -> HttpResult: ...


class HttpxTransport:
    def request(
        self, method: str, url: str, *, headers: dict[str, str], timeout: float
    ) -> HttpResult:
        try:
            response = httpx.request(
                method,
                url,
                headers=headers,
                timeout=timeout,
                follow_redirects=False,
                trust_env=False,  # no proxy / CA overrides from the environment
                verify=True,
            )
        except httpx.TimeoutException:
            raise TransportError("timeout") from None  # drop the cause: it may name the URL
        except httpx.HTTPError:
            raise TransportError("network") from None
        try:
            data = response.json()
        except ValueError:
            data = None
        return HttpResult(
            status=response.status_code, data=data if isinstance(data, dict) else None
        )


_transport: Transport | None = None


def get_transport() -> Transport:
    global _transport  # noqa: PLW0603
    if _transport is None:
        _transport = HttpxTransport()
    return _transport


def set_transport(transport: Transport | None) -> None:
    """Install a transport (tests pass a fake); None restores the real one lazily."""
    global _transport  # noqa: PLW0603
    _transport = transport
