"""Working-hours containment in Asia/Tashkent (the lot's ``open_time``/``close_time``)."""

from datetime import date, datetime, time, timedelta

from apps.parking.ranking import LOCAL_TZ


def _at(day: date, clock: time) -> datetime:
    return datetime.combine(day, clock, tzinfo=LOCAL_TZ)


def fits_working_hours(
    open_time: time | None, close_time: time | None, start: datetime, end: datetime
) -> bool:
    """True when ``[start, end]`` lies inside ONE opening window of the lot.

    NULL/NULL or ``open == close`` mean 24/7 (same convention as ``ranking.is_open_at``); only
    one of the two set is refused (it cannot exist: parking_lot_hours_both_or_none);
    ``open > close`` is an overnight window (22:00-06:00). The closing instant is inclusive for
    the END of a booking (a booking may finish exactly at closing time).
    """
    if (open_time is None) != (close_time is None):
        return False  # half a schedule is no schedule: fail closed (the DB forbids it anyway)
    if open_time is None or open_time == close_time:
        return True
    first = start.astimezone(LOCAL_TZ)
    day, clock = first.date(), first.time()
    if open_time < close_time:
        window_start, window_end = _at(day, open_time), _at(day, close_time)
    elif clock >= open_time:
        window_start, window_end = _at(day, open_time), _at(day + timedelta(days=1), close_time)
    elif clock < close_time:
        window_start, window_end = _at(day - timedelta(days=1), open_time), _at(day, close_time)
    else:
        return False
    return window_start <= start and end <= window_end
