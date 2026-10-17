from django.apps import AppConfig


def register_listeners() -> None:
    """Subscribe the publishers to the bookings events (idempotent)."""
    from apps.core import events

    from . import publishers

    events.subscribe("availability_changed", publishers.on_availability_changed)
    events.subscribe("booking_status", publishers.on_booking_status)
    events.subscribe("slot_status", publishers.on_slot_status)
    events.subscribe("slot_reassigned", publishers.on_slot_reassigned)


class RealtimeConfig(AppConfig):
    name = "apps.realtime"
    label = "realtime"

    def ready(self) -> None:
        register_listeners()
