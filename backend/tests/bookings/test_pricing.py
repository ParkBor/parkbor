"""Price calculation (ARCHITECTURE 10.5): pure Decimal maths, no DB."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from apps.bookings.pricing import (
    PricingConfig,
    calc_price,
    coefficient_at,
    dynamic_factor,
)

TZ = ZoneInfo("Asia/Tashkent")
PRICE = Decimal("6000")  # per hour -> 1500 per 15-minute block
CFG = PricingConfig()


def local(day, hh, mm=0):
    """Aware Asia/Tashkent datetime in October 2026 (2026-10-15 is a Thursday)."""
    return datetime(2026, 10, day, hh, mm, tzinfo=TZ)


def quote(start, end, rules=None, occupancy=None, price=PRICE, config=CFG):
    return calc_price(
        price_per_hour=price,
        rules=rules or {},
        start=start,
        end=end,
        occupancy=occupancy,
        config=config,
    )


def rule(coefficient, frm=None, to=None, days=None):
    item = {"coefficient": coefficient}
    if frm:
        item["from"], item["to"] = frm, to
    if days is not None:
        item["days"] = days
    return {"coefficients": [item]}


class TestBaseAndRounding:
    def test_two_hours_is_exactly_two_hours(self):
        q = quote(local(15, 14), local(15, 16))
        assert q.total == Decimal("12000.00")
        assert q.billed_minutes == 120
        assert q.total_minutes == 120

    @pytest.mark.parametrize(
        ("minutes", "billed", "total"),
        [
            (5, 0, "0.00"),  # inside the free window
            (10, 0, "0.00"),  # exactly the free window
            (11, 15, "1500.00"),  # 1 minute over -> one 15-minute block
            (25, 15, "1500.00"),
            (26, 30, "3000.00"),  # 16 billable minutes -> two blocks
            (30, 30, "3000.00"),  # the minimum booking
            (70, 60, "6000.00"),
            (71, 75, "7500.00"),
            (130, 120, "12000.00"),
            (131, 135, "13500.00"),
        ],
    )
    def test_free_minutes_then_fifteen_minute_blocks_rounded_up(self, minutes, billed, total):
        start = local(15, 14)
        q = quote(start, start + timedelta(minutes=minutes))
        assert q.billed_minutes == billed
        assert q.total == Decimal(total)

    def test_free_minutes_can_be_disabled(self):
        cfg = PricingConfig(free_minutes=0)
        q = quote(local(15, 14), local(15, 14, 30), config=cfg)
        assert q.billed_minutes == 30
        assert q.total == Decimal("3000.00")

    def test_twenty_four_hours(self):
        q = quote(local(15, 0), local(16, 0))
        assert q.total == Decimal("144000.00")  # 24 h * 6000

    def test_result_is_decimal_only(self):
        q = quote(local(15, 14), local(15, 16), occupancy=Decimal("0.9"))
        for value in (q.total, q.subtotal, q.dynamic_factor, q.price_per_hour):
            assert isinstance(value, Decimal)
        for seg in q.segments:
            assert isinstance(seg.amount, Decimal)
            assert isinstance(seg.coefficient, Decimal)

    def test_half_up_rounding_to_two_places(self):
        q = quote(local(15, 14), local(15, 14, 25), price=Decimal("4999.99"))
        # one block: 4999.99 * 15 / 60 = 1249.9975 -> 1250.00
        assert q.total == Decimal("1250.00")

    def test_zero_price_is_free(self):
        assert quote(local(15, 14), local(15, 16), price=Decimal("0")).total == Decimal("0.00")

    def test_utc_input_is_evaluated_in_tashkent_time(self):
        rules = rule("1.5", "07:00", "10:00")
        q = quote(
            datetime(2026, 10, 15, 3, 0, tzinfo=UTC),  # 08:00 Tashkent
            datetime(2026, 10, 15, 4, 0, tzinfo=UTC),
            rules,
        )
        assert q.total == Decimal("9000.00")

    @pytest.mark.parametrize(
        "bad", [(local(15, 14), local(15, 14)), (local(15, 15), local(15, 14))]
    )
    def test_empty_or_reversed_period_rejected(self, bad):
        with pytest.raises(ValueError, match="end must be after start"):
            quote(*bad)

    def test_naive_datetimes_rejected(self):
        with pytest.raises(ValueError, match="timezone-aware"):
            quote(datetime(2026, 10, 15, 14), datetime(2026, 10, 15, 16))


class TestCoefficients:
    def test_whole_booking_inside_peak(self):
        q = quote(local(15, 8), local(15, 9), rule("1.5", "07:00", "10:00"))
        assert q.total == Decimal("9000.00")
        assert len(q.segments) == 1
        assert q.segments[0].coefficient == Decimal("1.5")

    def test_booking_straddling_a_boundary_is_split_into_segments(self):
        q = quote(local(15, 9), local(15, 11), rule("1.5", "07:00", "10:00"))
        assert [s.coefficient for s in q.segments] == [Decimal("1.5"), Decimal("1")]
        assert [s.minutes for s in q.segments] == [60, 60]
        assert [s.amount for s in q.segments] == [Decimal("9000.00"), Decimal("6000.00")]
        assert q.subtotal == q.total == Decimal("15000.00")

    def test_overnight_rule_before_midnight_and_after(self):
        rules = rule("0.8", "22:00", "06:00")
        q = quote(local(15, 21), local(15, 23), rules)
        assert q.total == Decimal("10800.00")  # 1 h * 6000 + 1 h * 4800
        q2 = quote(local(16, 5), local(16, 7), rules)  # 05:00-06:00 night, 06:00-07:00 day
        assert q2.total == Decimal("10800.00")

    def test_overnight_rule_spill_belongs_to_the_day_it_started(self):
        # Starts Thursday (3) 22:00 -> covers Friday 00:00-06:00, but not Thursday 00:00-06:00.
        rules = rule("0.5", "22:00", "06:00", days=[3])
        assert quote(local(16, 2), local(16, 3), rules).total == Decimal("3000.00")  # Friday
        assert quote(local(15, 2), local(15, 3), rules).total == Decimal("6000.00")  # Thursday

    def test_days_filter(self):
        rules = rule("1.2", days=[5, 6])  # weekend, whole day
        assert quote(local(17, 10), local(17, 11), rules).total == Decimal("7200.00")  # Saturday
        assert quote(local(15, 10), local(15, 11), rules).total == Decimal("6000.00")  # Thursday

    def test_rule_without_time_range_covers_the_whole_day(self):
        assert quote(local(15, 10), local(15, 11), rule("2")).total == Decimal("12000.00")

    def test_block_takes_the_coefficient_of_its_start_time(self):
        # 06:50-07:50: blocks start 06:50 (x1), 07:05, 07:20, 07:35 (x1.5)
        q = quote(local(15, 6, 50), local(15, 7, 50), rule("1.5", "07:00", "10:00"))
        assert q.total == Decimal("1500.00") + 3 * Decimal("2250.00")

    def test_multiple_rules_pick_the_matching_one(self):
        rules = {
            "coefficients": [
                {"from": "07:00", "to": "10:00", "coefficient": "1.5"},
                {"from": "22:00", "to": "07:00", "coefficient": "0.5"},
            ]
        }
        assert coefficient_at(rules, local(15, 8)) == Decimal("1.5")
        assert coefficient_at(rules, local(15, 23)) == Decimal("0.5")
        assert coefficient_at(rules, local(15, 3)) == Decimal("0.5")
        assert coefficient_at(rules, local(15, 12)) == Decimal("1")

    @pytest.mark.parametrize("rules", [None, {}, {"coefficients": []}])
    def test_no_rules_means_coefficient_one(self, rules):
        assert coefficient_at(rules, local(15, 12)) == Decimal("1")

    def test_boundary_instants_open_inclusive_close_exclusive(self):
        rules = rule("2", "07:00", "10:00")
        assert coefficient_at(rules, local(15, 7)) == Decimal("2")
        assert coefficient_at(rules, local(15, 10)) == Decimal("1")


class TestDynamicFactor:
    @pytest.mark.parametrize(
        ("occupancy", "expected"),
        [
            (None, "1"),
            ("0", "1"),
            ("0.5", "1"),
            ("0.8", "1"),  # threshold is exclusive
            ("0.9", "1.05"),
            ("1", "1.1"),
        ],
    )
    def test_formula(self, occupancy, expected):
        value = None if occupancy is None else Decimal(occupancy)
        assert dynamic_factor(value, CFG) == Decimal(expected)

    def test_upper_bound_from_settings(self):
        cfg = PricingConfig(dynamic_max=Decimal("1.02"))
        assert dynamic_factor(Decimal("1"), cfg) == Decimal("1.02")

    def test_applied_on_top_of_segments(self):
        q = quote(local(15, 14), local(15, 16), occupancy=Decimal("0.9"))
        assert q.subtotal == Decimal("12000.00")
        assert q.dynamic_factor == Decimal("1.05")
        assert q.total == Decimal("12600.00")
        assert q.occupancy == Decimal("0.9")

    def test_out_of_range_occupancy_is_clamped(self):
        assert dynamic_factor(Decimal("3"), CFG) == Decimal("1.1")
        assert dynamic_factor(Decimal("-1"), CFG) == Decimal("1")
