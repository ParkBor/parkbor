from decimal import Decimal

import pytest

from apps.payments import money


@pytest.mark.parametrize(
    "soum, tiyin",
    [
        (Decimal("12000.00"), 1_200_000),
        (Decimal("0.01"), 1),
        (Decimal("1"), 100),
        (Decimal("99999999.99"), 9_999_999_999),
    ],
)
def test_to_tiyin_is_exact(soum, tiyin):
    assert money.to_tiyin(soum) == tiyin


def test_to_tiyin_rejects_sub_tiyin_amounts():
    with pytest.raises(ValueError):
        money.to_tiyin(Decimal("1.005"))


@pytest.mark.parametrize("bad", [0, -5])
def test_to_tiyin_rejects_non_positive(bad):
    with pytest.raises(ValueError):
        money.to_tiyin(Decimal(bad))


def test_from_tiyin_returns_two_decimal_places():
    assert money.from_tiyin(1_200_050) == Decimal("12000.50")
    assert isinstance(money.from_tiyin(100), Decimal)


@pytest.mark.parametrize("value", [1, 500000, Decimal("500000"), Decimal("5E+5")])
def test_parse_tiyin_accepts_whole_positive_numbers(value):
    assert money.parse_tiyin(value) == int(value)


@pytest.mark.parametrize(
    "value", [0, -1, True, False, None, "100", 1.5, Decimal("100.5"), [1], {"a": 1}, 10**15]
)
def test_parse_tiyin_rejects_everything_else(value):
    with pytest.raises(money.InvalidAmount):
        money.parse_tiyin(value)


@pytest.mark.parametrize(
    "text, expected",
    [("12000", "12000"), ("12000.0", "12000.0"), ("12000.00", "12000.00"), ("0.5", "0.5")],
)
def test_parse_soum_text_accepts_plain_decimals(text, expected):
    assert money.parse_soum_text(text) == Decimal(expected)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "abc",
        "1e3",
        "-5",
        "5.",
        ".5",
        "1,5",
        "12000.001",
        "NaN",
        "Infinity",
        " 5",
        "5 ",
        "0",
        "0.00",
    ],
)
def test_parse_soum_text_rejects_malformed_or_non_positive(text):
    with pytest.raises(money.InvalidAmount):
        money.parse_soum_text(text)


def test_format_soum_has_two_places_and_no_exponent():
    assert money.format_soum(Decimal("12000")) == "12000.00"
    assert money.format_soum(Decimal("1E+4")) == "10000.00"


@pytest.mark.parametrize(
    "value",
    [
        Decimal("1e999999999"),
        Decimal("-1e999999999"),
        Decimal("1E+30"),
        Decimal("NaN"),
        Decimal("Infinity"),
    ],
)
def test_parse_tiyin_rejects_huge_or_non_finite_decimals_without_expanding_them(value):
    with pytest.raises(money.InvalidAmount):
        money.parse_tiyin(value)


def test_parse_soum_text_is_ascii_only():
    with pytest.raises(money.InvalidAmount):
        money.parse_soum_text("١٢٠٠٠")  # Arabic-Indic digits match \d without re.ASCII
