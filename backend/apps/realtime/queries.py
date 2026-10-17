"""Database reads the realtime layer needs. Synchronous (ORM); the consumer wraps them with
``database_sync_to_async``. Everything returns plain values: no PII ever leaves this module.

Each function is ONE query for any number of ids (a client may name 50 groups in one message and
a heartbeat re-checks every joined operator lot at once)."""

from datetime import UTC, datetime

from apps.accounts.models import User
from apps.core.geo import point_to_lnglat
from apps.parking import access
from apps.parking.models import LotStatus, ParkingLot, Slot


def timestamp(now: datetime | None = None) -> str:
    """UTC ISO-8601 with MILLISECONDS (``2026-10-15T13:05:00.123Z``). Fixed width, so two stamps
    compare correctly as strings: a client drops an event older than its snapshot."""
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def user_is_active(user_id) -> bool:
    return User.objects.filter(pk=user_id, is_active=True).exists()


def lots_snapshot(lot_ids) -> dict[str, dict]:
    """``{lot id: {free_slots, total_slots, lng_lat}}`` for the ACTIVE lots among ``lot_ids``
    (drivers may follow ACTIVE lots only), straight from the database, never a cache. The same
    row answers "may I subscribe?" and "what is the current count?"."""
    rows = ParkingLot.objects.filter(pk__in=list(lot_ids), status=LotStatus.ACTIVE).values(
        "pk", "free_slots", "total_slots", "location"
    )
    return {
        str(row["pk"]): {
            "lot_id": str(row["pk"]),
            "free_slots": row["free_slots"],
            "total_slots": row["total_slots"],
            "lng_lat": point_to_lnglat(row["location"]),
        }
        for row in rows
    }


def availability_payload(snapshot: dict) -> dict:
    """The ``availability`` wire message for a snapshot (``ts`` = when it was read)."""
    return {
        "type": "availability",
        "lot_id": snapshot["lot_id"],
        "free_slots": snapshot["free_slots"],
        "total_slots": snapshot["total_slots"],
        "ts": timestamp(),
    }


def availability_snapshot(lot_id) -> dict | None:
    return lots_snapshot([lot_id]).get(str(lot_id))


def operable_lot_ids(user_id, lot_ids) -> tuple[bool, set[str]]:
    """``(user is still active, ids among lot_ids the user may run the gate of)``. Two small
    queries however many ids: the user row (only the fields access needs) and one
    ``operable_lots(user).filter(pk__in=...)``. Re-read on every call: a revoked operator or a
    demoted account loses the live slot feed at the next check."""
    user = User.objects.filter(pk=user_id, is_active=True).only("id", "role", "is_active").first()
    if user is None:
        return False, set()
    ids = list(lot_ids)
    if not ids:
        return True, set()
    allowed = access.operable_lots(user).filter(pk__in=ids).values_list("pk", flat=True)
    return True, {str(pk) for pk in allowed}


def slot_statuses(slot_ids) -> dict[str, str]:
    rows = Slot.objects.filter(pk__in=list(slot_ids)).values_list("pk", "status")
    return {str(pk): status for pk, status in rows}
