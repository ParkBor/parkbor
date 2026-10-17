from apps.parking.models import (
    LotStatus,
    ParkingLot,
    Slot,
    SlotStatus,
    SlotType,
    Tariff,
    Zone,
)


def test_enums_match_architecture():
    assert set(LotStatus.values) == {"PENDING_REVIEW", "ACTIVE", "SUSPENDED"}
    assert set(SlotType.values) == {"STANDARD", "EV", "DISABLED", "LARGE"}
    assert set(SlotStatus.values) == {"FREE", "RESERVED", "OCCUPIED", "OUT_OF_SERVICE"}


def test_new_lot_defaults_to_pending_review():
    assert ParkingLot._meta.get_field("status").default == LotStatus.PENDING_REVIEW


def test_lot_has_named_gist_index_on_location():
    indexes = {i.name: i for i in ParkingLot._meta.indexes}
    assert "parking_lot_location_gist" in indexes
    assert indexes["parking_lot_location_gist"].fields == ["location"]
    assert type(indexes["parking_lot_location_gist"]).__name__ == "GistIndex"


def test_price_is_decimal_field():
    field = Tariff._meta.get_field("price_per_hour")
    assert field.get_internal_type() == "DecimalField"
    assert field.decimal_places == 2


def test_uniqueness_constraints_present():
    assert {c.name for c in Slot._meta.constraints} == {"slot_unique_code_in_zone"}
    assert {c.name for c in Zone._meta.constraints} == {"zone_unique_name_in_lot"}
    assert {c.name for c in Tariff._meta.constraints} == {
        "tariff_unique_type_in_lot",
        "tariff_price_non_negative",
    }
