"""Database reads the realtime layer needs. Synchronous (ORM); the consumer wraps them with
``database_sync_to_async``. Everything returns plain values: no PII ever leaves this module."""

from datetime import UTC, datetime

from apps.accounts.models import User
from apps.core.geo import point_to_lnglat
from apps.parking import access
from apps.parking.models import LotStatus, ParkingLot, Slot


def timestamp(now: datetime | None = None) -> str:
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


def active_user(user_id) -> User | None:
    return User.objects.filter(pk=user_id, is_active=True).first()


def lot_is_subscribable(lot_id) -> bool:
    """Drivers may follow ACTIVE lots only (a pending or suspended lot is not public)."""
    return ParkingLot.objects.filter(pk=lot_id, status=LotStatus.ACTIVE).exists()


def operates_lot(user_id, lot_id) -> bool:
    """May this user run the lot's gate NOW? Re-read from the database on every call: a revoked
    operator or a demoted account loses the live slot feed at the next check."""
    user = active_user(user_id)
    return user is not None and access.get_operable_lot(user, lot_id) is not None


def availability_snapshot(lot_id) -> dict | None:
    """``{lot_id, free_slots, total_slots, geohash lat/lng}`` of an ACTIVE lot, from the database
    (never a cache), or None."""
    row = (
        ParkingLot.objects.filter(pk=lot_id, status=LotStatus.ACTIVE)
        .values("pk", "free_slots", "total_slots", "location")
        .first()
    )
    if row is None:
        return None
    where = point_to_lnglat(row["location"])
    return {
        "lot_id": str(row["pk"]),
        "free_slots": row["free_slots"],
        "total_slots": row["total_slots"],
        "lng_lat": where,
    }


def slot_statuses(slot_ids) -> dict[str, str]:
    rows = Slot.objects.filter(pk__in=list(slot_ids)).values_list("pk", "status")
    return {str(pk): status for pk, status in rows}
