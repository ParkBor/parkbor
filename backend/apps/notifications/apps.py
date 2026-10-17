from django.apps import AppConfig


def register_listeners() -> None:
    """Subscribe to the bookings / payments events (idempotent)."""
    from apps.core import events

    from . import listeners

    events.subscribe("booking_status", listeners.on_booking_status)
    events.subscribe("overstay_detected", listeners.on_overstay_detected)
    events.subscribe("slot_reassigned", listeners.on_slot_reassigned)
    events.subscribe("overstay_conflict", listeners.on_overstay_conflict)
    events.subscribe("refund_final", listeners.on_refund_final)


class NotificationsConfig(AppConfig):
    name = "apps.notifications"
    label = "notifications"

    def ready(self) -> None:
        register_listeners()
