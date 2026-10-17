"""Working-hours containment (Asia/Tashkent, overnight windows, 24/7)."""

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

import pytest

from apps.bookings.hours import fits_working_hours

TZ = ZoneInfo("Asia/Tashkent")


def at(day, hh, mm=0):
    return datetime(2026, 10, day, hh, mm, tzinfo=TZ)


DAY = (time(8, 0), time(20, 0))
NIGHT = (time(22, 0), time(6, 0))


class TestDayWindow:
    def test_inside(self):
        assert fits_working_hours(*DAY, at(15, 9), at(15, 11))

    def test_exact_edges_are_allowed(self):
        assert fits_working_hours(*DAY, at(15, 8), at(15, 20))

    def test_starts_before_opening(self):
        assert not fits_working_hours(*DAY, at(15, 7, 59), at(15, 10))

    def test_ends_after_closing(self):
        assert not fits_working_hours(*DAY, at(15, 19), at(15, 20, 1))

    def test_spanning_two_days_is_outside_a_day_window(self):
        assert not fits_working_hours(*DAY, at(15, 19), at(16, 9))

    def test_evaluated_in_tashkent_not_utc(self):
        # 04:00Z = 09:00 Tashkent -> inside; 02:00Z = 07:00 Tashkent -> before opening
        inside = (datetime(2026, 10, 15, 4, tzinfo=UTC), datetime(2026, 10, 15, 6, tzinfo=UTC))
        early = (datetime(2026, 10, 15, 2, tzinfo=UTC), datetime(2026, 10, 15, 4, tzinfo=UTC))
        assert fits_working_hours(*DAY, *inside)
        assert not fits_working_hours(*DAY, *early)


class TestOvernightWindow:
    def test_evening_to_after_midnight(self):
        assert fits_working_hours(*NIGHT, at(15, 23), at(16, 2))

    def test_early_morning_part(self):
        assert fits_working_hours(*NIGHT, at(16, 1), at(16, 5))

    def test_whole_window(self):
        assert fits_working_hours(*NIGHT, at(15, 22), at(16, 6))

    def test_runs_past_closing(self):
        assert not fits_working_hours(*NIGHT, at(16, 5), at(16, 7))

    def test_starts_in_the_closed_gap(self):
        assert not fits_working_hours(*NIGHT, at(15, 12), at(15, 14))

    def test_crosses_into_the_closed_gap(self):
        assert not fits_working_hours(*NIGHT, at(15, 23), at(16, 7))


class TestAlwaysOpen:
    def test_missing_hours_mean_open(self):
        assert fits_working_hours(None, None, at(15, 3), at(16, 3))

    @pytest.mark.parametrize(("open_time", "close_time"), [(None, time(6)), (time(8), None)])
    def test_half_a_schedule_fails_closed(self, open_time, close_time):
        assert not fits_working_hours(open_time, close_time, at(15, 3), at(16, 3))

    def test_equal_times_mean_24h(self):
        assert fits_working_hours(time(0), time(0), at(15, 3), at(16, 3))
