"""Period rules shared by booking creation, extension and the read-only quotes."""

from datetime import datetime

from apps.parking.models import ParkingLot

from .conf import BookingConfig, get_config
from .errors import rule_violation
from .hours import fits_working_hours


def floor_minute(value: datetime) -> datetime:
    return value.replace(second=0, microsecond=0)


def check_duration(start: datetime, end: datetime, cfg: BookingConfig | None = None) -> None:
    cfg = cfg or get_config()
    if end <= start:
        raise rule_violation("period_invalid", "The end must be after the start.")
    if end - start < cfg.min_duration:
        minutes = int(cfg.min_duration.total_seconds() // 60)
        raise rule_violation("period_too_short", f"A booking lasts at least {minutes} minutes.")
    if end - start > cfg.max_duration:
        hours = int(cfg.max_duration.total_seconds() // 3600)
        raise rule_violation("period_too_long", f"A booking lasts at most {hours} hours.")


def validate_period(
    *,
    lot: ParkingLot,
    start: datetime,
    end: datetime,
    now: datetime,
    cfg: BookingConfig | None = None,
    check_hours: bool = True,
) -> tuple[datetime, datetime]:
    """Rules for a NEW period; returns the normalised (whole-minute) start and end.

    Order: shape and length -> not in the past (tolerance) -> not too far ahead -> lot hours.
    """
    cfg = cfg or get_config()
    start, end = floor_minute(start), floor_minute(end)
    check_duration(start, end, cfg)
    if start < now - cfg.start_tolerance:
        raise rule_violation("start_in_past", "The start time has already passed.")
    if start > now + cfg.max_advance:
        days = cfg.max_advance.days
        raise rule_violation("too_far_ahead", f"Bookings open at most {days} days ahead.")
    if check_hours and not fits_working_hours(lot.open_time, lot.close_time, start, end):
        raise rule_violation("lot_closed", "The parking lot is closed during this period.")
    return start, end
