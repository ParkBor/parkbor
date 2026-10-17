"""Startup validation of OSRM_URL (pure; imported by settings, so no Django imports)."""

from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

_MESSAGE = (
    "OSRM_URL must be a bare http:// or https:// origin (scheme, host, optional port): "
    "no credentials, path, query or fragment."
)


def validate_osrm_url(url: str) -> str:
    """Return `url` if it is ``scheme://host[:port][/]``, else fail startup.

    Credentials, a path, a query or a fragment are rejected: request paths are built by the
    client, and secrets in a URL leak into logs. The message never echoes the value.
    """
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
        parts.port  # noqa: B018 - raises ValueError for a malformed/out-of-range port
    except ValueError:
        raise ImproperlyConfigured(_MESSAGE) from None
    bare = (
        parts.scheme in {"http", "https"}
        and bool(hostname)
        and parts.username is None
        and parts.password is None
        and "@" not in parts.netloc
        and parts.path in {"", "/"}
        and not parts.query
        and not parts.fragment
        and "?" not in url
        and "#" not in url
    )
    if not bare:
        raise ImproperlyConfigured(_MESSAGE)
    return url
