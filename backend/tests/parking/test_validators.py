import pytest

from apps.parking.validators import (
    MAX_BULK_SLOTS,
    RulesError,
    generate_slot_codes,
    validate_tariff_rules,
)


class TestGenerateSlotCodes:
    def test_zone_a_one_to_fifty(self):
        codes = generate_slot_codes("A", 1, 50)
        assert len(codes) == 50
        assert codes[0] == "A-1"
        assert codes[-1] == "A-50"
        assert len(set(codes)) == 50

    def test_single_slot(self):
        assert generate_slot_codes("B", 7, 7) == ["B-7"]

    @pytest.mark.parametrize("start,end", [(0, 5), (-1, 5), (5, 4)])
    def test_rejects_bad_range(self, start, end):
        with pytest.raises(ValueError, match="range"):
            generate_slot_codes("A", start, end)

    @pytest.mark.parametrize("prefix", ["", "A B", "A-1", "ЖЖ", "x" * 11, "A;DROP", None])
    def test_rejects_bad_prefix(self, prefix):
        with pytest.raises(ValueError, match="prefix"):
            generate_slot_codes(prefix, 1, 2)

    def test_end_is_capped(self):
        with pytest.raises(ValueError, match="99999"):
            generate_slot_codes("A", 99999, 100000)

    def test_longest_code_fits_the_column(self):
        assert max(len(c) for c in generate_slot_codes("ABCDEFGHIJ", 99999, 99999)) <= 20

    def test_boundary_of_max_size(self):
        assert len(generate_slot_codes("A", 1, MAX_BULK_SLOTS)) == MAX_BULK_SLOTS
        with pytest.raises(ValueError, match="at most"):
            generate_slot_codes("A", 1, MAX_BULK_SLOTS + 1)


class TestTariffRules:
    def test_empty_ok(self):
        assert validate_tariff_rules({}) == {}
        assert validate_tariff_rules(None) == {}

    def test_valid_coefficients(self):
        rules = {
            "coefficients": [
                {"days": [5, 6], "coefficient": "1.5"},
                {"days": [0, 1], "from": "22:00", "to": "06:00", "coefficient": 0.8},
            ]
        }
        result = validate_tariff_rules(rules)
        assert [c["coefficient"] for c in result["coefficients"]] == ["1.5", "0.8"]

    @pytest.mark.parametrize(
        "rules",
        [
            [],
            "x",
            {"other": 1},
            {"coefficients": "x"},
            {"coefficients": ["x"]},
            {"coefficients": [{}]},
            {"coefficients": [{"coefficient": "0"}]},
            {"coefficients": [{"coefficient": "-1"}]},
            {"coefficients": [{"coefficient": "11"}]},
            {"coefficients": [{"coefficient": "NaN"}]},
            {"coefficients": [{"coefficient": "abc"}]},
            {"coefficients": [{"coefficient": 1, "days": []}]},
            {"coefficients": [{"coefficient": 1, "days": [7]}]},
            {"coefficients": [{"coefficient": 1, "days": [True]}]},
            {"coefficients": [{"coefficient": 1, "from": "25:00"}]},
            {"coefficients": [{"coefficient": 1, "to": "6:00"}]},
        ],
    )
    def test_invalid(self, rules):
        with pytest.raises(RulesError):
            validate_tariff_rules(rules)
