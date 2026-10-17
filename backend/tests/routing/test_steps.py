"""simplify_steps: OSRM maneuvers -> small stable instruction keys, safe names, bounded size."""

import pytest

from apps.routing.steps import (
    INSTRUCTION_KEYS,
    MAX_NAME_LENGTH,
    MAX_STEPS,
    simplify_steps,
)


def raw(kind, modifier=None, name="Main St", dist=100.4, dur=20.6, lat=41.3, lng=69.2):
    return {
        "name": name,
        "distance": dist,
        "duration": dur,
        "location": {"lat": lat, "lng": lng},
        "maneuver": {"type": kind, "modifier": modifier},
    }


def key(kind, modifier=None):
    return simplify_steps([raw(kind, modifier)])[0]["instruction_key"]


class TestInstructionKeys:
    @pytest.mark.parametrize(
        "kind,modifier,expected",
        [
            ("depart", None, "depart"),
            ("depart", "right", "depart"),
            ("arrive", "left", "arrive"),
            ("turn", "left", "turn_left"),
            ("turn", "right", "turn_right"),
            ("turn", "slight left", "slight_left"),
            ("turn", "slight right", "slight_right"),
            ("turn", "sharp left", "sharp_left"),
            ("turn", "sharp right", "sharp_right"),
            ("turn", "straight", "straight"),
            ("turn", "uturn", "uturn"),
            ("turn", None, "other"),
            ("turn", "weird", "other"),
            ("continue", "straight", "continue"),
            ("continue", None, "continue"),
            ("continue", "uturn", "uturn"),
            ("continue", "left", "slight_left"),
            ("continue", "right", "slight_right"),
            ("continue", "sharp left", "sharp_left"),
            ("new name", "straight", "continue"),
            ("new name", "slight left", "slight_left"),
            ("new name", "right", "slight_right"),
            ("end of road", "left", "turn_left"),
            ("end of road", "right", "turn_right"),
            ("end of road", None, "other"),
            ("merge", "left", "merge_left"),
            ("merge", "slight right", "merge_right"),
            ("merge", "straight", "merge"),
            ("merge", None, "merge"),
            ("fork", "slight right", "fork_right"),
            ("fork", "left", "fork_left"),
            ("fork", "sharp left", "fork_left"),
            ("fork", "straight", "fork"),
            ("fork", None, "fork"),
            ("on ramp", "right", "ramp_right"),
            ("off ramp", "left", "ramp_left"),
            ("off ramp", "slight left", "ramp_left"),
            ("on ramp", "straight", "ramp"),
            ("on ramp", None, "ramp"),
            ("roundabout", "right", "roundabout"),
            ("rotary", "left", "roundabout"),
            ("roundabout turn", "left", "roundabout"),
            ("exit roundabout", "right", "roundabout"),
            ("exit rotary", None, "roundabout"),
            ("notification", None, "other"),
            ("use lane", "straight", "other"),
            ("totally unknown", "left", "other"),
        ],
    )
    def test_mapping(self, kind, modifier, expected):
        assert key(kind, modifier) == expected

    def test_every_output_key_is_in_the_documented_set(self):
        for kind in ("turn", "fork", "merge", "depart", "arrive", "zzz", "on ramp"):
            for modifier in (None, "left", "uturn", "straight", "sharp right", "junk"):
                assert key(kind, modifier) in INSTRUCTION_KEYS

    def test_documented_set(self):
        assert set(INSTRUCTION_KEYS) == {
            "depart", "arrive", "turn_left", "turn_right", "slight_left", "slight_right",
            "sharp_left", "sharp_right", "straight", "uturn", "roundabout", "merge",
            "fork", "ramp", "continue", "other",
            "merge_left", "merge_right", "fork_left", "fork_right", "ramp_left", "ramp_right",
        }  # fmt: skip

    def test_legacy_keys_are_still_valid(self):
        assert {"merge", "fork", "ramp"} <= set(INSTRUCTION_KEYS)


class TestStepShape:
    def test_output_contract(self):
        step = simplify_steps([raw("turn", "left", "Amir Temur", 120.5, 30.4, 41.31, 69.27)])[0]
        assert step == {
            "instruction_key": "turn_left",
            "name": "Amir Temur",
            "distance_m": 120,
            "duration_s": 30,
            "location": {"lat": 41.31, "lng": 69.27},
            "maneuver": {"type": "turn", "modifier": "left", "exit": None},
        }

    def test_roundabout_exit_is_passed_through(self):
        step = raw("roundabout", "right")
        step["maneuver"]["exit"] = 3
        out = simplify_steps([step])[0]
        assert out["instruction_key"] == "roundabout"
        assert out["maneuver"]["exit"] == 3

    def test_modifier_none_is_kept_as_none(self):
        assert simplify_steps([raw("arrive")])[0]["maneuver"]["modifier"] is None

    def test_empty_input(self):
        assert simplify_steps([]) == []

    def test_input_is_not_mutated(self):
        steps = [raw("turn", "left", name="a\x00b")]
        before = repr(steps)
        simplify_steps(steps)
        assert repr(steps) == before


class TestNameSafety:
    def test_control_characters_removed(self):
        assert (
            simplify_steps([raw("turn", "left", "A\x00B\x1b[31mC\nD\tE\x7f")])[0]["name"]
            == "AB[31mC D E"
        )

    def test_bidi_and_zero_width_controls_removed(self):
        assert simplify_steps([raw("turn", "left", "A‮B​C⁦D")])[0]["name"] == "ABCD"

    def test_whitespace_collapsed_and_trimmed(self):
        assert (
            simplify_steps([raw("turn", "left", "  Amir   Temur \n ")])[0]["name"] == "Amir Temur"
        )

    def test_length_is_capped(self):
        name = simplify_steps([raw("turn", "left", "x" * 5000)])[0]["name"]
        assert len(name) == MAX_NAME_LENGTH

    def test_unicode_names_survive(self):
        assert simplify_steps([raw("turn", "left", "Амир Темур ko‘chasi 🚗")])[0]["name"] == (
            "Амир Темур ko‘chasi 🚗"
        )

    def test_maneuver_strings_are_sanitised_and_capped(self):
        step = simplify_steps([raw("tu\x00rn" + "x" * 100, "le\nft" + "y" * 100)])[0]
        assert len(step["maneuver"]["type"]) <= 32
        assert len(step["maneuver"]["modifier"]) <= 32
        assert "\x00" not in step["maneuver"]["type"] and "\n" not in step["maneuver"]["modifier"]

    def test_non_string_name_becomes_empty(self):
        assert simplify_steps([raw("turn", "left", name=None)])[0]["name"] == ""


class TestStepCap:
    def test_up_to_the_cap_is_untouched(self):
        steps = [raw("turn", "left", name=str(i)) for i in range(MAX_STEPS)]
        assert len(simplify_steps(steps)) == MAX_STEPS

    def test_over_cap_keeps_first_and_last_and_total_equals_cap(self):
        steps = [raw("depart")] + [raw("turn", "left", name=str(i)) for i in range(2000)]
        steps.append(raw("arrive"))
        result = simplify_steps(steps)
        assert len(result) == MAX_STEPS
        assert result[0]["instruction_key"] == "depart"
        assert result[-1]["instruction_key"] == "arrive"

    def test_over_cap_preserves_total_distance_and_duration(self):
        steps = [raw("depart", dist=10, dur=1)]
        steps += [raw("turn", "left", dist=7 + i % 5, dur=2 + i % 3) for i in range(1500)]
        steps += [raw("arrive", dist=0, dur=0)]
        result = simplify_steps(steps)
        assert len(result) == MAX_STEPS
        assert sum(s["distance_m"] for s in result) == sum(round(s["distance"]) for s in steps)
        assert sum(s["duration_s"] for s in result) == sum(round(s["duration"]) for s in steps)

    def test_least_important_steps_are_merged_first(self):
        steps = [raw("depart", dist=1, dur=1)]
        steps += [raw("turn", "left", dist=10, dur=10) for _ in range(MAX_STEPS - 2)]
        steps += [raw("continue", "straight", dist=5, dur=5) for _ in range(10)]
        steps += [raw("arrive", dist=0, dur=0)]
        result = simplify_steps(steps)
        assert len(result) == MAX_STEPS
        keys = [s["instruction_key"] for s in result]
        assert keys.count("turn_left") == MAX_STEPS - 2  # no real turn was lost
        assert "continue" not in keys
        assert result[-1]["instruction_key"] == "arrive"

    def test_merged_distance_goes_to_the_previous_step(self):
        steps = [raw("depart", dist=1, dur=1)]
        steps += [raw("turn", "left", dist=10, dur=10) for _ in range(MAX_STEPS - 2)]
        steps += [raw("continue", "straight", dist=5, dur=6), raw("arrive", dist=0, dur=0)]
        result = simplify_steps(steps)
        assert result[-2]["distance_m"] == 15 and result[-2]["duration_s"] == 16

    def test_does_not_mutate_input_when_merging(self):
        steps = [raw("depart")] + [raw("turn", "left") for _ in range(900)] + [raw("arrive")]
        before = repr(steps)
        simplify_steps(steps)
        assert repr(steps) == before

    def test_cap_is_500(self):
        assert MAX_STEPS == 500
