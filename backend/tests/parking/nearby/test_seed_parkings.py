"""`manage.py seed_parkings`: 30 Tashkent test lots, idempotent, dev only."""

from io import StringIO

import pytest
from django.core.management import CommandError, call_command
from django.db.models import Count

from apps.accounts.models import User
from apps.parking.models import LotStatus, ParkingLot, Slot, Tariff, Zone

pytestmark = pytest.mark.django_db


@pytest.fixture
def dev(settings):
    settings.DEBUG = True
    settings.ALLOW_SEED = True


def run():
    out = StringIO()
    call_command("seed_parkings", stdout=out)
    return out.getvalue()


def counts():
    return (
        ParkingLot.objects.count(),
        Zone.objects.count(),
        Slot.objects.count(),
        Tariff.objects.count(),
        User.objects.count(),
    )


def test_refuses_outside_debug(settings):
    settings.DEBUG = False
    settings.ALLOW_SEED = True
    with pytest.raises(CommandError, match="DEBUG"):
        run()
    assert ParkingLot.objects.count() == 0
    assert User.objects.count() == 0


def test_debug_alone_is_not_enough(settings):
    """A staging box with DEBUG=True must not seed by accident: ALLOW_SEED is also required."""
    settings.DEBUG = True
    settings.ALLOW_SEED = False
    with pytest.raises(CommandError, match="ALLOW_SEED"):
        run()
    assert ParkingLot.objects.count() == 0


def test_allow_seed_alone_is_not_enough(settings):
    settings.DEBUG = False
    settings.ALLOW_SEED = True
    with pytest.raises(CommandError, match="DEBUG"):
        run()


def test_allow_seed_defaults_to_off_except_in_dev_settings():
    import importlib
    import sys

    from django.conf import settings

    assert getattr(settings, "ALLOW_SEED", False) is False  # test settings
    for name in ("config.settings.dev",):
        sys.modules.pop(name, None)
    assert importlib.import_module("config.settings.dev").ALLOW_SEED is True


def test_owner_id_can_never_be_a_real_telegram_id(dev):
    from apps.parking.seed_data import SEED_OWNER_TELEGRAM_ID

    assert SEED_OWNER_TELEGRAM_ID < 0  # Telegram user ids are positive
    run()
    assert User.objects.get(role="OWNER").telegram_id == SEED_OWNER_TELEGRAM_ID


def test_phone_collision_does_not_crash(dev):
    from apps.parking.seed_data import SEED_OWNER_PHONE

    User.objects.create_user(123456789, phone=SEED_OWNER_PHONE)
    run()
    assert ParkingLot.objects.count() == 30
    assert User.objects.get(telegram_id__lt=0).phone is None


def test_refreshes_planner_statistics_at_the_end(dev, monkeypatch):
    from apps.parking import selectors

    calls = []
    monkeypatch.setattr(selectors, "analyze_parking_lots", lambda: calls.append(1))
    run()
    assert calls == [1]


def test_creates_thirty_active_lots_with_owner(dev):
    run()
    assert ParkingLot.objects.count() == 30
    assert set(ParkingLot.objects.values_list("status", flat=True)) == {LotStatus.ACTIVE}
    owners = User.objects.filter(role="OWNER")
    assert owners.count() == 1
    owner = owners.get()
    assert owner.telegram_id and owner.phone
    assert ParkingLot.objects.filter(owner=owner).count() == 30
    assert not owner.has_usable_password()


def test_is_idempotent(dev):
    run()
    first = counts()
    output = run()
    assert counts() == first
    assert "30" in output


def test_partial_state_is_completed_without_duplicates(dev):
    run()
    ParkingLot.objects.filter(
        name__in=list(ParkingLot.objects.values_list("name", flat=True)[:5])
    ).delete()
    run()
    assert ParkingLot.objects.count() == 30
    assert ParkingLot.objects.values("name").annotate(n=Count("id")).filter(n__gt=1).count() == 0


def test_lots_have_zones_slots_tariffs_and_consistent_counters(dev):
    run()
    for lot in ParkingLot.objects.all():
        assert lot.zones.count() >= 1
        assert lot.tariffs.filter(slot_type="STANDARD").exists()
        slots = Slot.objects.filter(zone__parking_lot=lot)
        assert lot.total_slots == slots.count() > 0
        assert lot.free_slots == slots.filter(status="FREE").count()
        assert 0 <= lot.free_slots <= lot.total_slots


def test_data_is_varied(dev):
    run()
    lots = ParkingLot.objects.all()
    assert len({lot.free_slots for lot in lots}) > 5
    assert len({lot.rating for lot in lots}) > 5
    assert lots.filter(free_slots=0).exists()  # at least one full lot
    prices = set(
        Tariff.objects.filter(slot_type="STANDARD").values_list("price_per_hour", flat=True)
    )
    assert len(prices) > 5
    assert Slot.objects.filter(type="EV").exists()
    assert Slot.objects.filter(type="DISABLED").exists()
    assert lots.filter(open_time__isnull=False).exists()
    assert lots.filter(open_time__isnull=True).exists()


def test_coordinates_are_in_tashkent(dev):
    from apps.core.geo import point_to_lnglat

    run()
    for lot in ParkingLot.objects.all():
        lng, lat = point_to_lnglat(lot.location)
        assert 41.15 < lat < 41.45
        assert 69.05 < lng < 69.45


def test_names_are_unique_and_include_landmarks(dev):
    run()
    names = list(ParkingLot.objects.values_list("name", flat=True))
    assert len(set(names)) == 30
    joined = " ".join(names)
    for landmark in ("Chorsu", "Amir Temur", "Yunusobod", "Chilonzor"):
        assert landmark in joined


def test_seeded_lots_are_found_by_nearby_search(dev, driver):
    from tests.helpers import client_for

    run()
    response = client_for(driver).get("/api/v1/parkings/nearby", {"lat": 41.3265, "lng": 69.2347})
    assert response.status_code == 200
    assert response.json()["count"] >= 3
