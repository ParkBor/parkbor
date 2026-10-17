"""Notification event names (ARCHITECTURE 12.1) and which of them are critical."""

BOOKING_CONFIRMED = "booking_confirmed"
BOOKING_EXPIRED = "booking_expired"
BOOKING_CANCELLED = "booking_cancelled"
NO_SHOW = "no_show"
REMINDER_15M_LEFT = "reminder_15m_left"
OVERSTAY_DETECTED = "overstay_detected"
SLOT_REASSIGNED = "slot_reassigned"
OVERSTAY_CONFLICT = "overstay_conflict"
REFUND_DONE = "refund_done"
REFUND_MANUAL = "refund_manual"
REFUND_FAILED = "refund_failed"

EVENTS = frozenset(
    {
        BOOKING_CONFIRMED,
        BOOKING_EXPIRED,
        BOOKING_CANCELLED,
        NO_SHOW,
        REMINDER_15M_LEFT,
        OVERSTAY_DETECTED,
        SLOT_REASSIGNED,
        OVERSTAY_CONFLICT,
        REFUND_DONE,
        REFUND_MANUAL,
        REFUND_FAILED,
    }
)

# Critical: the driver must not miss it (money or a car in the way) -> every enabled channel.
# Everything else: push first, Telegram only as the fallback.
CRITICAL_EVENTS = frozenset({OVERSTAY_DETECTED, OVERSTAY_CONFLICT, REFUND_MANUAL, REFUND_FAILED})
