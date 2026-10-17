"""Deterministic dev/test data for `manage.py seed_parkings`.

Coordinates are approximate positions of well-known Tashkent places; the lots themselves are
fictional. Everything is derived from the list index, so repeated runs produce identical data.
"""

from dataclasses import dataclass
from datetime import time
from decimal import Decimal

# Negative: real Telegram user ids are positive, so this can never collide with a real account.
SEED_OWNER_TELEGRAM_ID = -900_000_001
SEED_OWNER_PHONE = "+998900000001"
SEED_OWNER_NAME = "Seed Owner"

# (name, address, lat, lng)
PLACES: tuple[tuple[str, str, float, float], ...] = (
    ("Chorsu Bozori", "Chorsu, Eski Shahar", 41.3265, 69.2347),
    ("Hazrati Imom", "Hazrati Imom majmuasi", 41.3395, 69.2350),
    ("Amir Temur Xiyoboni", "Amir Temur shoh ko'chasi", 41.3111, 69.2797),
    ("Mustaqillik Maydoni", "Mustaqillik maydoni", 41.3036, 69.2663),
    ("Yunusobod 4-kvartal", "Yunusobod tumani, 4-kvartal", 41.3655, 69.2870),
    ("Yunusobod Metro", "Yunusobod metro bekati", 41.3670, 69.2840),
    ("Minor Masjidi", "Minor masjidi yonida", 41.3236, 69.2864),
    ("Chilonzor Metro", "Chilonzor metro bekati", 41.2757, 69.2044),
    ("Chilonzor 9-kvartal", "Chilonzor tumani, 9-kvartal", 41.2840, 69.2100),
    ("Bunyodkor Stadioni", "Bunyodkor shoh ko'chasi", 41.2765, 69.1990),
    ("Novza Metro", "Novza metro bekati", 41.2828, 69.1664),
    ("Beruniy Metro", "Beruniy metro bekati", 41.3459, 69.2056),
    ("Oybek Metro", "Oybek metro bekati", 41.3087, 69.2855),
    ("Toshkent Vokzali", "Temir yo'l vokzali", 41.2933, 69.2850),
    ("Toshkent Aeroporti", "Islom Karimov aeroporti", 41.2579, 69.2812),
    ("Sergeli Bozori", "Sergeli tumani", 41.2252, 69.2208),
    ("Yashnobod Savdo Markazi", "Yashnobod tumani", 41.3000, 69.3300),
    ("Magic City", "Toshkent Siti yonida", 41.3255, 69.3185),
    ("Teleminora", "Teleminora, Shayxontohur", 41.3427, 69.2863),
    ("Ecopark", "Ecopark, Yashnobod", 41.3156, 69.3056),
    ("Navoiy Teatri", "Navoiy teatri yonida", 41.3079, 69.2630),
    ("Samarqand Darvoza", "Samarqand Darvoza ko'chasi", 41.3327, 69.2224),
    ("Shayxontohur Markazi", "Shayxontohur tumani", 41.3200, 69.2200),
    ("Olmazor Bozori", "Olmazor tumani", 41.3440, 69.2260),
    ("Uchtepa Markazi", "Uchtepa tumani", 41.2950, 69.1700),
    ("Yakkasaroy", "Yakkasaroy tumani", 41.2900, 69.2550),
    ("Mirobod Markazi", "Mirobod tumani", 41.2990, 69.2760),
    ("Mirzo Ulugbek Markazi", "Mirzo Ulugbek tumani", 41.3395, 69.3340),
    ("Bektemir", "Bektemir tumani", 41.2150, 69.3350),
    ("Tashkent City", "Tashkent City majmuasi", 41.3130, 69.2475),
)

# Opening hours cycle: 24/7, day, long day, overnight, 24/7.
HOURS: tuple[tuple[time, time] | None, ...] = (
    None,
    (time(8, 0), time(22, 0)),
    (time(6, 0), time(23, 0)),
    (time(20, 0), time(4, 0)),
    None,
)

FULL_LOT_INDEXES = frozenset({4, 17, 26})  # no free slot at all
NEARLY_FULL_INDEXES = frozenset({2, 9, 13, 21})  # one or two free slots


@dataclass(frozen=True)
class LotSpec:
    name: str
    address: str
    lat: float
    lng: float
    standard_slots: int
    occupied_share: float
    standard_price: Decimal
    rating: float
    hours: tuple[time, time] | None
    ev_slots: int
    disabled_slots: int
    large_slots: int


def build_specs() -> list[LotSpec]:
    specs = []
    for index, (name, address, lat, lng) in enumerate(PLACES):
        standard = 12 + (index * 7) % 30  # 12..41
        if index in FULL_LOT_INDEXES:
            share = 1.0
        elif index in NEARLY_FULL_INDEXES:
            share = 0.97
        else:
            share = ((index * 13) % 90) / 100  # 0.00..0.89
        specs.append(
            LotSpec(
                name=name,
                address=address,
                lat=lat,
                lng=lng,
                standard_slots=standard,
                occupied_share=share,
                standard_price=Decimal(5000 + (index * 1700) % 11000 // 500 * 500),
                rating=0.0 if index % 7 == 0 else round(3.0 + (index * 37 % 21) / 10, 1),
                hours=HOURS[index % len(HOURS)],
                ev_slots=4 if index % 3 == 0 else 0,
                disabled_slots=2,
                large_slots=3 if index % 4 == 0 else 0,
            )
        )
    return specs
