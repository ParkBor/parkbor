"""Booking settings, read at call time (so ``override_settings`` works in tests).

All values live in ``config/settings/base.py`` (``BOOKING_*``); this module only gives them
types and groups them. Moving them into the admin "settings" section later means changing this
single reader.
"""

import logging
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.core.cache import cache
from django.db import DatabaseError, transaction

from .pricing import PricingConfig

logger = logging.getLogger(__name__)

# Admin-editable settings (key -> (django setting name, low, high)). The environment value is the
# default; a ``BookingSetting`` row overrides it. Ranges mirror ``config/settings/base.py``.
EDITABLE_SETTINGS: dict[str, tuple[str, int, int]] = {
    "hold_minutes": ("BOOKING_HOLD_MINUTES", 1, 120),
    "no_show_grace_minutes": ("BOOKING_NO_SHOW_GRACE_MINUTES", 1, 240),
    "cancel_full_refund_minutes": ("BOOKING_CANCEL_FULL_REFUND_MINUTES", 0, 10080),
    "cancel_full_percent": ("BOOKING_CANCEL_FULL_PERCENT", 0, 100),
    "cancel_late_percent": ("BOOKING_CANCEL_LATE_PERCENT", 0, 100),
    "cancel_after_start_percent": ("BOOKING_CANCEL_AFTER_START_PERCENT", 0, 100),
}
OVERRIDES_CACHE_KEY = "booking_setting_overrides"
OVERRIDES_CACHE_SECONDS = 30
OVERRIDES_FAILURE_CACHE_SECONDS = 5


def load_overrides() -> dict[str, int]:
    """Admin overrides, cached for a few seconds (``update_settings`` clears the cache). A failed
    read falls back to the environment defaults: bookings must keep working."""
    cached = cache.get(OVERRIDES_CACHE_KEY)
    if cached is not None:
        return cached
    from .models import BookingSetting

    try:
        with transaction.atomic():  # savepoint: a failed read must not poison the caller's tx
            rows = dict(BookingSetting.objects.values_list("key", "value"))
    except DatabaseError:
        logger.exception("booking setting overrides unreadable; using defaults")
        cache.set(OVERRIDES_CACHE_KEY, {}, OVERRIDES_FAILURE_CACHE_SECONDS)
        return {}
    rows = {key: value for key, value in rows.items() if key in EDITABLE_SETTINGS}
    cache.set(OVERRIDES_CACHE_KEY, rows, OVERRIDES_CACHE_SECONDS)
    return rows


def effective_settings() -> dict[str, int]:
    """Value of every editable setting: override if present, else the environment default."""
    overrides = load_overrides()
    return {
        key: overrides.get(key, getattr(settings, name))
        for key, (name, _, _) in EDITABLE_SETTINGS.items()
    }


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
    eff = effective_settings()
    return BookingConfig(
        min_duration=timedelta(minutes=s.BOOKING_MIN_DURATION_MINUTES),
        max_duration=timedelta(hours=s.BOOKING_MAX_DURATION_HOURS),
        max_advance=timedelta(days=s.BOOKING_MAX_ADVANCE_DAYS),
        start_tolerance=timedelta(minutes=s.BOOKING_START_TOLERANCE_MINUTES),
        hold=timedelta(minutes=eff["hold_minutes"]),
        no_show_grace=timedelta(minutes=eff["no_show_grace_minutes"]),
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
            full_refund_minutes=eff["cancel_full_refund_minutes"],
            full_percent=eff["cancel_full_percent"],
            late_percent=eff["cancel_late_percent"],
            after_start_percent=eff["cancel_after_start_percent"],
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
