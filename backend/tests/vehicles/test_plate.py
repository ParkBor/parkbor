"""Plate normalisation and the soft Uzbekistan format check."""

import pytest

from apps.vehicles.plate import InvalidPlate, is_standard_uz_plate, normalize_plate


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("01 A 123 BC", "01A123BC"),
        ("01a123bc", "01A123BC"),
        (" 01-123-abc ", "01123ABC"),
        ("01 A\t123\nBC", "01A123BC"),
        ("30 A 1234", "30A1234"),
    ],
)
def test_normalisation_uppercases_and_strips_separators(raw, expected):
    assert normalize_plate(raw) == expected


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "   ",
        "ABCDE",
        "12345",
        "A1",
        "01A123BC" * 3,
        "01 A 12$ BC",
        "01А123ВС",  # Cyrillic look-alikes
        "ß1234",
        "<script>1",
    ],
)
def test_garbage_is_rejected(bad):
    with pytest.raises(InvalidPlate):
        normalize_plate(bad)


def test_non_string_rejected():
    with pytest.raises(InvalidPlate):
        normalize_plate(None)  # type: ignore[arg-type]
    with pytest.raises(InvalidPlate):
        normalize_plate(12345)  # type: ignore[arg-type]


@pytest.mark.parametrize("plate", ["01A123BC", "01123ABC", "30A1234", "95A123BC"])
def test_standard_formats(plate):
    assert is_standard_uz_plate(plate)


@pytest.mark.parametrize("plate", ["ZZ9999", "1A2B3C4D", "00A123BC"])
def test_non_standard_is_flagged_but_not_an_error(plate):
    assert not is_standard_uz_plate(plate)
