"""System checks: production hygiene that cannot be a hard startup error."""

from django.conf import settings
from django.core.checks import Tags, Warning, register  # noqa: A004


@register(Tags.security, deploy=True)
def check_provider_ip_allowlist(app_configs, **kwargs):
    """The webhooks are protected by signatures / Basic auth; the IP allowlist is the second
    layer. Not mandatory (Click's addresses must be obtained from CLICK), but recommended."""
    from .conf import ip_allowlist

    missing = [p for p in ("payme", "click") if not ip_allowlist(p)]
    if not missing:
        return []
    return [
        Warning(
            f"No provider IP allowlist for: {', '.join(missing)}.",
            hint="Set PAYMENTS_PROVIDER_IPS (or PAYMENTS_PAYME_IPS / PAYMENTS_CLICK_IPS).",
            id="payments.W001",
        )
    ]


@register(Tags.security, deploy=True)
def check_sandbox_off(app_configs, **kwargs):
    if not settings.PAYMENTS_SANDBOX or settings.DEBUG:
        return []
    return [
        Warning(
            "PAYMENTS_SANDBOX is on outside DEBUG.",
            hint="Sandbox checkout URLs must not be used with real customers.",
            id="payments.W002",
        )
    ]
