"""Read queries. Every admin-facing queryset is scoped by the acting user's role.

No select_related here on purpose: list serializers only emit foreign keys (pk-only fields), so
extra joins would just cost; tests/adminpanel/test_hardening.py::TestQueryCounts guards N+1.

The "nearby search" section at the bottom serves the driver API (ARCHITECTURE 10.1).
"""

from decimal import Decimal

from django.db import connection
from django.db.models import (
    CharField,
    Count,
    Exists,
    F,
    FloatField,
    Func,
    Min,
    OuterRef,
    Q,
    QuerySet,
    Value,
)

from apps.core.geo import HAS_GIS, make_point, point_to_lnglat
from apps.core.geomath import haversine_m
from apps.core.permissions import is_owner, is_super_admin

from .models import LotStatus, ParkingLot, Slot, SlotStatus, Tariff, Zone
from .ranking import NearbyLot


def _scope(queryset: QuerySet, user, owner_path: str) -> QuerySet:
    if is_super_admin(user):
        return queryset
    if is_owner(user):
        return queryset.filter(**{owner_path: user.pk})
    return queryset.none()


def lots_for_user(user) -> QuerySet[ParkingLot]:
    return _scope(ParkingLot.objects.all(), user, "owner_id")


def zones_for_user(user) -> QuerySet[Zone]:
    return _scope(Zone.objects.all(), user, "parking_lot__owner_id")


def slots_for_user(user) -> QuerySet[Slot]:
    return _scope(Slot.objects.all(), user, "zone__parking_lot__owner_id")


def tariffs_for_user(user) -> QuerySet[Tariff]:
    return _scope(Tariff.objects.all(), user, "parking_lot__owner_id")


# --- nearby search (driver API, ARCHITECTURE 10.1) --------------------------------------------

_NEARBY_FIELDS = (
    "id",
    "name",
    "address",
    "location",
    "free_slots",
    "total_slots",
    "rating",
    "open_time",
    "close_time",
)


def uses_postgis() -> bool:
    """True when the real spatial query (ST_DWithin + KNN) can run; else the Python fallback."""
    return HAS_GIS and connection.vendor == "postgresql"


class GeographyKnn(Func):
    """``location <-> <point>``: the PostGIS KNN distance operator on geography.

    Django's ``Distance()`` compiles to ``ST_Distance(...)``, which a GiST index cannot order by;
    only the bare ``<->`` operator in ORDER BY (+ LIMIT) triggers the index-assisted KNN scan.
    """

    arg_joiner = " <-> "
    template = "(%(expressions)s)"
    output_field = FloatField()


def knn_order_expression(lat: float, lng: float) -> GeographyKnn:
    ewkt = f"SRID=4326;POINT({float(lng):.7f} {float(lat):.7f})"
    point = Func(Value(ewkt, output_field=CharField()), function="ST_GeogFromText")
    return GeographyKnn(F("location"), point)


def knn_order_sql(lat: float, lng: float) -> str:
    """The SQL of the ORDER BY clause (for tests/inspection)."""
    query = ParkingLot.objects.order_by(knn_order_expression(lat, lng)).query
    sql, _params = query.sql_with_params()
    return sql.split("ORDER BY", 1)[1].strip()


def _searchable_lots(slot_type: str | None) -> QuerySet[ParkingLot]:
    """ACTIVE lots that have a free slot (of `slot_type` when given).

    Without a slot type the denormalised ``free_slots`` counter decides (cheap); with one, a
    live EXISTS over the slot rows does, since the counter is type-blind.
    """
    lots = ParkingLot.objects.filter(status=LotStatus.ACTIVE)
    if slot_type is None:
        return lots.filter(free_slots__gt=0)
    free_of_type = Slot.objects.filter(
        zone__parking_lot=OuterRef("pk"), type=slot_type, status=SlotStatus.FREE
    )
    return lots.filter(Exists(free_of_type))


def nearby_lot_queryset(
    lat: float, lng: float, radius_m: int, slot_type: str | None, cap: int
) -> QuerySet:
    """The PostGIS candidate query: ACTIVE filter + ST_DWithin + bare ``<->`` KNN ORDER BY +
    LIMIT. Keep this exact shape: it is what lets the planner use the ordered GiST scan (the
    partial ``parking_lot_loc_active_gist`` index matches the status predicate)."""
    from django.contrib.gis.measure import D

    lots = _searchable_lots(slot_type).filter(
        location__dwithin=(make_point(lng, lat), D(m=radius_m))
    )
    return lots.order_by(knn_order_expression(lat, lng)).values(*_NEARBY_FIELDS)[:cap]


def _rows_postgis(lat: float, lng: float, radius_m: int, slot_type, cap: int) -> list[dict]:
    return list(nearby_lot_queryset(lat, lng, radius_m, slot_type, cap))


def analyze_parking_lots() -> bool:
    """Refresh planner statistics (PostgreSQL only; no-op elsewhere). Call after bulk loads:
    stale statistics are what makes the planner pick a bad plan for the KNN query."""
    if connection.vendor != "postgresql":
        return False
    with connection.cursor() as cursor:
        cursor.execute("ANALYZE parking_lot")
    return True


def _rows_python(lat: float, lng: float, radius_m: int, slot_type, cap: int) -> list[dict]:
    """Same result without PostGIS (SQLite dev/test boxes): full scan + Haversine. Never used
    in production, where GDAL is mandatory (see apps.core.geo)."""
    scored = []
    for row in _searchable_lots(slot_type).values(*_NEARBY_FIELDS).iterator():
        lng_l, lat_l = point_to_lnglat(row["location"])
        distance = haversine_m(lat, lng, lat_l, lng_l)
        if distance <= radius_m:
            scored.append((distance, str(row["id"]), row))
    scored.sort(key=lambda item: item[:2])
    return [row for _distance, _id, row in scored[:cap]]


def _type_counts(lot_ids: list, slot_type: str) -> dict:
    rows = (
        Slot.objects.filter(zone__parking_lot_id__in=lot_ids, type=slot_type)
        .order_by()  # Slot.Meta.ordering would leak into GROUP BY
        .values("zone__parking_lot_id")
        .annotate(total=Count("id"), free=Count("id", filter=Q(status=SlotStatus.FREE)))
    )
    return {r["zone__parking_lot_id"]: (r["free"], r["total"]) for r in rows}


def _min_prices(lot_ids: list, slot_type: str | None) -> dict[object, Decimal]:
    tariffs = Tariff.objects.filter(parking_lot_id__in=lot_ids)
    if slot_type is not None:
        tariffs = tariffs.filter(slot_type=slot_type)
    rows = tariffs.order_by().values("parking_lot_id").annotate(price=Min("price_per_hour"))
    return {r["parking_lot_id"]: r["price"] for r in rows}


def nearby_candidates(
    *, lat: float, lng: float, radius_m: int, slot_type: str | None, cap: int
) -> list[NearbyLot]:
    """Up to `cap` lots within `radius_m` of the point, nearest first (KNN on PostGIS).

    With `slot_type`, ``free_slots``/``total_slots`` count slots of that type only and the price
    is that type's tariff; otherwise they are the lot counters and the cheapest tariff.
    """
    finder = _rows_postgis if uses_postgis() else _rows_python
    rows = finder(lat, lng, radius_m, slot_type, cap)
    if not rows:
        return []
    ids = [row["id"] for row in rows]
    prices = _min_prices(ids, slot_type)
    counts = _type_counts(ids, slot_type) if slot_type else {}
    lots = []
    for row in rows:
        lng_l, lat_l = point_to_lnglat(row["location"])
        if slot_type:
            free, total = counts.get(row["id"], (0, 0))
        else:
            free, total = row["free_slots"], row["total_slots"]
        lots.append(
            NearbyLot(
                id=str(row["id"]),
                name=row["name"],
                address=row["address"],
                lat=lat_l,
                lng=lng_l,
                free_slots=free,
                total_slots=total,
                price_per_hour=prices.get(row["id"]),
                rating=row["rating"] or None,  # 0 means "no reviews yet"
                open_time=row["open_time"],
                close_time=row["close_time"],
            )
        )
    return lots
