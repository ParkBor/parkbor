"""Booking settings, read at call time (so ``override_settings`` works in tests).

All values live in ``config/settings/base.py`` (``BOOKING_*``); this module only gives them
types and groups them. Moving them into the admin "settings" section later means changing this
single reader.
"""

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from django.conf import settings

from .pricing import PricingConfig


@dataclass(frozen=True)
class CancelPolicy:
    full_refund_minutes: int
    full_percent: int
    late_percent: int
    after_start_percent: int


@dataclass(frozen=True)
class BookingConfig:
    min_duration: timedelta
    max_duration: timedelta
    max_advance: timedelta
    start_tolerance: timedelta
    hold: timedelta
    no_show_grace: timedelta
    immediate_window: timedelta
    qr_grace: timedelta
    qr_early: timedelta
    max_pending: int
    max_active: int
    cooldown_threshold: int
    cooldown_window: timedelta
    extend_enabled: bool
    lock_timeout_seconds: int
    max_pick_attempts: int
    task_batch_limit: int
    cancel_policy: CancelPolicy
    pricing: PricingConfig
    idempotency_ttl: int
    idempotency_lock: int
    idempotency_wait: float
    checkin_early: timedelta = timedelta(minutes=30)
    qr_exit_minutes: int = 720
    walkin_max: timedelta = timedelta(hours=4)
    walkin_min_gap: timedelta = timedelta(minutes=15)
    overstay_reassign: timedelta = timedelta(minutes=15)
    walkin_buffer: timedelta = timedelta(minutes=5)


def get_config() -> BookingConfig:
    s = settings
    return BookingConfig(
        min_duration=timedelta(minutes=s.BOOKING_MIN_DURATION_MINUTES),
        max_duration=timedelta(hours=s.BOOKING_MAX_DURATION_HOURS),
        max_advance=timedelta(days=s.BOOKING_MAX_ADVANCE_DAYS),
        start_tolerance=timedelta(minutes=s.BOOKING_START_TOLERANCE_MINUTES),
        hold=timedelta(minutes=s.BOOKING_HOLD_MINUTES),
        no_show_grace=timedelta(minutes=s.BOOKING_NO_SHOW_GRACE_MINUTES),
        immediate_window=timedelta(minutes=s.BOOKING_IMMEDIATE_WINDOW_MINUTES),
        qr_grace=timedelta(minutes=s.BOOKING_QR_GRACE_MINUTES),
        qr_early=timedelta(minutes=s.BOOKING_QR_EARLY_MINUTES),
        max_pending=s.BOOKING_MAX_PENDING,
        max_active=s.BOOKING_MAX_ACTIVE,
        cooldown_threshold=s.BOOKING_COOLDOWN_THRESHOLD,
        cooldown_window=timedelta(minutes=s.BOOKING_COOLDOWN_WINDOW_MINUTES),
        extend_enabled=bool(s.BOOKING_EXTEND_ENABLED),
        lock_timeout_seconds=s.BOOKING_LOCK_TIMEOUT_SECONDS,
        max_pick_attempts=s.BOOKING_MAX_PICK_ATTEMPTS,
        task_batch_limit=s.BOOKING_TASK_BATCH_LIMIT,
        cancel_policy=CancelPolicy(
            full_refund_minutes=s.BOOKING_CANCEL_FULL_REFUND_MINUTES,
            full_percent=s.BOOKING_CANCEL_FULL_PERCENT,
            late_percent=s.BOOKING_CANCEL_LATE_PERCENT,
            after_start_percent=s.BOOKING_CANCEL_AFTER_START_PERCENT,
        ),
        pricing=PricingConfig(
            free_minutes=s.BOOKING_FREE_MINUTES,
            block_minutes=s.BOOKING_ROUNDING_MINUTES,
            dynamic_threshold=Decimal(str(s.BOOKING_DYNAMIC_THRESHOLD)),
            dynamic_slope=Decimal(str(s.BOOKING_DYNAMIC_SLOPE)),
            dynamic_max=Decimal(str(s.BOOKING_DYNAMIC_MAX_FACTOR)),
        ),
        idempotency_ttl=s.BOOKING_IDEMPOTENCY_TTL_SECONDS,
        idempotency_lock=s.BOOKING_IDEMPOTENCY_LOCK_SECONDS,
        idempotency_wait=float(s.BOOKING_IDEMPOTENCY_WAIT_SECONDS),
        checkin_early=timedelta(minutes=s.BOOKING_CHECKIN_EARLY_MINUTES),
        qr_exit_minutes=s.BOOKING_QR_EXIT_MINUTES,
        walkin_max=timedelta(hours=s.BOOKING_WALKIN_MAX_HOURS),
        walkin_min_gap=timedelta(minutes=s.BOOKING_WALKIN_MIN_GAP_MINUTES),
        overstay_reassign=timedelta(minutes=s.BOOKING_OVERSTAY_REASSIGN_MINUTES),
        walkin_buffer=timedelta(minutes=s.BOOKING_WALKIN_BUFFER_MINUTES),
    )
