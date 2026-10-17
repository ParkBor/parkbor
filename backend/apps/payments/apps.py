from django.apps import AppConfig


class PaymentsConfig(AppConfig):
    name = "apps.payments"
    label = "payments"

    def ready(self) -> None:
        from apps.bookings import hooks

        from . import checks  # noqa: F401  (registers the system checks)
        from .refunds import create_booking_refund

        hooks.set_refund_handler(create_booking_refund)
