import pytest

from apps.parking.validators import RulesError, validate_tariff_rules


def rule(**kw):
    return {"coefficient": "1.5", **kw}


def test_coefficients_are_normalised_to_decimal_strings():
    result = validate_tariff_rules(
        {"coefficients": [rule(days=[1], coefficient=1.50), rule(days=[0], coefficient=2)]}
    )
    assert [c["coefficient"] for c in result["coefficients"]] == ["1.5", "2"]
    assert all(isinstance(c["coefficient"], str) for c in result["coefficients"])


def test_input_is_not_mutated():
    original = {"coefficients": [rule(coefficient=1.5)]}
    validate_tariff_rules(original)
    assert original["coefficients"][0]["coefficient"] == 1.5


def test_too_many_coefficients_rejected():
    rules = {
        "coefficients": [rule(days=[i % 7], **{"from": "00:00", "to": "00:01"}) for i in range(51)]
    }
    with pytest.raises(RulesError, match="at most"):
        validate_tariff_rules(rules)


@pytest.mark.parametrize("item", [{"from": "08:00"}, {"to": "09:00"}])
def test_from_and_to_must_come_together(item):
    with pytest.raises(RulesError, match="together"):
        validate_tariff_rules({"coefficients": [rule(**item)]})


def test_from_equal_to_rejected():
    with pytest.raises(RulesError):
        validate_tariff_rules({"coefficients": [rule(**{"from": "08:00", "to": "08:00"})]})


def test_duplicate_days_rejected():
    with pytest.raises(RulesError, match="duplicate"):
        validate_tariff_rules({"coefficients": [rule(days=[1, 1])]})


def test_too_many_decimals_rejected():
    with pytest.raises(RulesError):
        validate_tariff_rules({"coefficients": [rule(coefficient="1.23456")]})


def test_overlapping_rules_rejected():
    rules = {
        "coefficients": [
            rule(days=[0, 1], **{"from": "08:00", "to": "12:00"}),
            rule(days=[1], **{"from": "11:00", "to": "13:00"}),
        ]
    }
    with pytest.raises(RulesError, match="overlap"):
        validate_tariff_rules(rules)


def test_whole_day_rule_overlaps_timed_rule_on_same_day():
    rules = {"coefficients": [rule(days=[2]), rule(days=[2], **{"from": "01:00", "to": "02:00"})]}
    with pytest.raises(RulesError, match="overlap"):
        validate_tariff_rules(rules)


def test_overnight_rule_spills_into_next_day():
    rules = {
        "coefficients": [
            rule(days=[0], **{"from": "22:00", "to": "06:00"}),
            rule(days=[1], **{"from": "05:00", "to": "07:00"}),
        ]
    }
    with pytest.raises(RulesError, match="overlap"):
        validate_tariff_rules(rules)


def test_adjacent_and_disjoint_rules_are_fine():
    rules = {
        "coefficients": [
            rule(days=[0], **{"from": "08:00", "to": "12:00"}),
            rule(days=[0], **{"from": "12:00", "to": "14:00"}),
            rule(days=[1], **{"from": "08:00", "to": "12:00"}),
            rule(days=[0], **{"from": "22:00", "to": "06:00"}),
        ]
    }
    assert len(validate_tariff_rules(rules)["coefficients"]) == 4
