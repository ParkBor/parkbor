"""Dashboard numbers (ARCHITECTURE 9.3.1 ``stats/*``). Day boundaries are Asia/Tashkent days;
money is Decimal and leaves as a string. Each endpoint is a handful of aggregate queries that do
not depend on the number of rows.

Definitions (also in the doc):
* ``revenue`` = online payments (PAID / REFUNDED) by ``performed_at``, net of the refunded amount.
  Cash taken at the gate (walk-ins, overstay) is not included.
* ``bookings_today`` = bookings created today that are not unpaid / expired.
* ``occupancy`` = OCCUPIED + RESERVED slots of ACTIVE lots, share of their WORKING slots (slots
  that are OUT_OF_SERVICE are in neither the numerator nor ``total_slots``).
* ``from`` / ``to`` are rounded to Asia/Tashkent calendar days: the day of ``from`` through the
  day before ``to`` (``to`` is exclusive).
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

from django.db.models import Count, Q, QuerySet
from django.utils import timezone

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus, OverstayStatus
from apps.core.exceptions import DomainValidationError
from apps.core.permissions import is_owner, is_super_admin
from apps.parking.models import LotStatus, ParkingLot, Slot, SlotStatus
from apps.payments import admin_api as payments_api

TASHKENT = ZoneInfo("Asia/Tashkent")
MAX_REVENUE_DAYS = 92
DEFAULT_REVENUE_DAYS = 7
MAX_OCCUPANCY_LOTS = 500
CENT = Decimal("0.01")
ZERO = Decimal("0.00")
OCCUPIED_STATES = (SlotStatus.OCCUPIED, SlotStatus.RESERVED)
NOT_DEMAND = (BookingStatus.PENDING_PAYMENT, BookingStatus.EXPIRED)


def money(value) -> str:
    return format(Decimal(value or 0).quantize(CENT, rounding=ROUND_HALF_UP), "f")


def percent(part: int, whole: int) -> str:
    if whole <= 0:
        return "0.00"
    share = (Decimal(part) * 100 / Decimal(whole)).quantize(CENT, rounding=ROUND_HALF_UP)
    return format(share, "f")


def local_day_start(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=TASHKENT)


@dataclass(frozen=True)
class Scope:
    """The caller's lots (optionally narrowed to one) as a queryset of ParkingLot."""

    lots: QuerySet[ParkingLot]

    @classmethod
    def build(cls, user, lot_id=None) -> "Scope":
        lots = ParkingLot.objects.all()
        if is_owner(user):
            lots = lots.filter(owner_id=user.pk)
        elif not is_super_admin(user):
            lots = lots.none()
        if lot_id is not None:
            lots = lots.filter(pk=lot_id)
        return cls(lots=lots)

    def exists(self) -> bool:
        return self.lots.exists()

    @property
    def ids(self):
        return self.lots.values("pk")


def overview(scope: Scope, now: datetime | None = None) -> dict:
    now = (now or timezone.now()).astimezone(TASHKENT)
    today = now.date()
    today_start = local_day_start(today)
    tomorrow_start = local_day_start(today + timedelta(days=1))
    month_start = local_day_start(today.replace(day=1))
    bookings = Booking.objects.filter(slot__zone__parking_lot__in=scope.ids).aggregate(
        today=Count(
            "id",
            filter=Q(created_at__gte=today_start, created_at__lt=tomorrow_start)
            & ~Q(status__in=NOT_DEMAND),
        ),
        active=Count("id", filter=Q(status__in=(BookingStatus.ACTIVE, BookingStatus.OVERSTAY))),
        overstay_due=Count("id", filter=Q(overstay_status=OverstayStatus.DUE)),
    )
    revenue = payments_api.revenue_totals(
        scope.ids, since=month_start, until=tomorrow_start, today_since=today_start
    )
    active_lots = scope.lots.filter(status=LotStatus.ACTIVE).values("pk")
    slots = (
        Slot.objects.filter(zone__parking_lot__in=active_lots)
        .exclude(status=SlotStatus.OUT_OF_SERVICE)
        .aggregate(total=Count("id"), occupied=Count("id", filter=Q(status__in=OCCUPIED_STATES)))
    )
    refunds = payments_api.attention_count(scope.ids)
    return {
        "bookings_today": bookings["today"],
        "bookings_active": bookings["active"],
        "revenue_today": money(revenue["today"]),
        "revenue_month": money(revenue["month"]),
        "occupancy_percent": percent(slots["occupied"], slots["total"]),
        "total_slots": slots["total"],
        "occupied_slots": slots["occupied"],
        "lots_pending_review": scope.lots.filter(status=LotStatus.PENDING_REVIEW).count(),
        "refunds_needing_attention": refunds,
        "overstay_due": bookings["overstay_due"],
    }


def revenue_series(
    scope: Scope, start: datetime | None, end: datetime | None, now: datetime | None = None
) -> list[dict]:
    today = (now or timezone.now()).astimezone(TASHKENT).date()
    # ``to`` is exclusive (the start of the next day): the last day is the one just before it
    last = (end - timedelta(microseconds=1)).astimezone(TASHKENT).date() if end else today
    if start:
        first = start.astimezone(TASHKENT).date()
    else:
        first = last - timedelta(days=DEFAULT_REVENUE_DAYS - 1)
    if first > last:
        raise DomainValidationError("The start of the range must not be later than its end.")
    if (last - first).days + 1 > MAX_REVENUE_DAYS:
        raise DomainValidationError(f"The range may cover at most {MAX_REVENUE_DAYS} days.")
    by_day = payments_api.daily_revenue(
        scope.ids,
        since=local_day_start(first),
        until=local_day_start(last + timedelta(days=1)),
        tz=TASHKENT,
    )
    points = []
    for offset in range((last - first).days + 1):
        day = first + timedelta(days=offset)
        row = by_day.get(day)
        points.append(
            {
                "date": day.isoformat(),
                "revenue": money(row["revenue"] if row else 0),
                "bookings": row["bookings"] if row else 0,
            }
        )
    return points


def occupancy_rows(scope: Scope) -> list[dict]:
    lots = (
        scope.lots.filter(status=LotStatus.ACTIVE)
        .annotate(
            total=Count("zones__slots", filter=~Q(zones__slots__status=SlotStatus.OUT_OF_SERVICE)),
            occupied=Count("zones__slots", filter=Q(zones__slots__status__in=OCCUPIED_STATES)),
        )
        .order_by("name", "id")[:MAX_OCCUPANCY_LOTS]
    )
    return [
        {
            "parking_lot": {"id": lot.pk, "name": lot.name},
            "total_slots": lot.total,
            "occupied_slots": lot.occupied,
            "occupancy_percent": percent(lot.occupied, lot.total),
        }
        for lot in lots
    ]
