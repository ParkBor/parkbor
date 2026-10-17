from .base import PaymentProvider


def get_provider(code: str) -> PaymentProvider:
    """The adapter for ``code`` ("payme" | "click"). Imports lazily: adapters import services."""
    if code == "payme":
        from .payme import PaymeProvider

        return PaymeProvider()
    if code == "click":
        from .click import ClickProvider

        return ClickProvider()
    raise KeyError(code)
